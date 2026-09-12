import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, type SubcommandDefinition, definePlugin, type CommandInvocation, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {
  buildMessageLink, DEFAULT_PROMPT, extractFileName, extractUrlsFromEntities, formatDate,
  formatMessagesForAI, htmlEscape,
  type CustomProvider, type MessageData, type SummaryDB, type SummaryTask,
} from "./v2/model";
import {htmlPages} from "./v2/output";

const defaults: SummaryDB = {seq: "0", tasks: [], aiConfig: {providers: {},
  default_prompt: DEFAULT_PROMPT, default_spoiler: false, max_output_length: 0,
  link_preview: false, aiMigrated: true}};
class UserError extends Error {}
const requireValue: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new UserError(message);
};
const store = (ctx: PluginContext) => ctx.storage.json<SummaryDB>("database.json", defaults);
function scrubLegacyAiSettings(config: SummaryDB["aiConfig"]): void {
  delete config.default_provider;
  delete config.default_timeout;
  delete config.default_reasoning_effort;
  delete config.default_service_tier;
  delete config.reply_mode;
}
const numericPeer = async (value: string): Promise<unknown> => {
  if (!/^-?\d+$/.test(value)) return value;
  const {returnBigInt} = await import("teleproto/Helpers.js");
  return returnBigInt(value);
};

function intervalCron(interval: string): string {
  const match = interval.toLowerCase().match(/^(\d+)(m|h|d)$/);
  requireValue(match, "间隔格式示例：30m、2h、1d");
  const value = Number(match[1]);
  requireValue(Number.isSafeInteger(value) && value > 0, "间隔必须为正整数");
  if (match[2] === "m") {
    requireValue(value <= 59 && 60 % value === 0, "分钟间隔须为 1-59 且能整除 60");
    return `*/${value} * * * *`;
  }
  if (match[2] === "h") {
    requireValue(value <= 23 && 24 % value === 0, "小时间隔须为 1-23 且能整除 24");
    return `0 */${value} * * *`;
  }
  requireValue(value === 1, "当前按天间隔仅支持 1d");
  return "0 0 * * *";
}

function providerUrl(provider: CustomProvider, type: "gemini" | "anthropic" | "openai-compatible"): string {
  const url = new URL(provider.base_url); let pathname = url.pathname.replace(/\/+$/, ""); url.search = ""; url.hash = "";
  if (type === "gemini") { if (!/\/v1beta$/i.test(pathname)) pathname = pathname.replace(/\/v1$/i, "") + "/v1beta"; }
  else if (!/\/v1$/i.test(pathname)) pathname += "/v1";
  url.pathname = pathname;
  return url.toString();
}
function providerType(provider: CustomProvider): {type:"gemini"|"anthropic"|"openai-compatible"; responses:boolean} {
  const model = provider.model.toLowerCase();
  if (provider.type === "gemini" || model.startsWith("gemini")) return {type:"gemini", responses:false};
  if (provider.type === "anthropic" || model.startsWith("claude")) return {type:"anthropic", responses:false};
  return {type:"openai-compatible", responses:provider.type === "responses" ||
    (!provider.type || provider.type === "auto" || provider.type === "openai") && /^(gpt-[5-9]|o[1-9])/.test(model)};
}
async function migrateAi(ctx: PluginContext): Promise<void> {
  const db = await store(ctx).read(ctx.signal);
  if (db.aiConfig.aiMigrated) return;
  const candidates = Object.entries(db.aiConfig.providers).sort(([a], [b]) => a.localeCompare(b));
  const entries: Array<[string, CustomProvider]> = [];
  let skipped = 0;
  for (const [name, value] of candidates) {
    if (!value || typeof value !== "object" || typeof value.base_url !== "string" ||
        typeof value.api_key !== "string" || !value.api_key.trim() || typeof value.model !== "string" || !value.model.trim()) {
      skipped += 1;
      continue;
    }
    try {
      const detected = providerType(value);
      providerUrl(value, detected.type);
      entries.push([name, value]);
    } catch {
      skipped += 1;
    }
  }
  if (skipped) ctx.log.info("sum:legacy-provider-skipped", {count: skipped});
  if (!entries.length) {
    await store(ctx).update(value => {value.aiConfig.providers = {}; value.aiConfig.aiMigrated = true; scrubLegacyAiSettings(value.aiConfig); return value;}, ctx.signal); return;
  }
  if (!ctx.services.available("ai", "import_provider")) return;
  const tags: Record<string,string> = {};
  for (let index = 0; index < entries.length; index++) {
    const [name, provider] = entries[index]!; const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    const requestedTag = `sum-${safe || index + 1}`.slice(0, 64);
    const detected = providerType(provider);
    const imported = await ctx.services.call<{tag?:string}>("ai", "import_provider", {tag:requestedTag, url:providerUrl(provider, detected.type), key:provider.api_key,
      type:detected.type, responses:detected.responses, models:{chat:provider.model},
      select:name === db.aiConfig.default_provider ? ["chat"] : []}, ctx.signal);
    tags[name] = imported?.tag || requestedTag;
  }
  await store(ctx).update(value => {
    value.tasks = value.tasks.map(task => task.aiProvider && tags[task.aiProvider] ? {...task, aiProvider:tags[task.aiProvider]} : task);
    value.aiConfig.providers = {}; value.aiConfig.aiMigrated = true; scrubLegacyAiSettings(value.aiConfig); return value;
  }, ctx.signal);
}

async function readMessages(ctx: PluginContext, chatId: string, beforeId: number | undefined, count: number, caller: AbortSignal): Promise<{data: MessageData[]; title: string}> {
  return ctx.telegram.withClient(async (client, signal) => {
    const active = AbortSignal.any([signal, caller]);
    active.throwIfAborted();
    const peer = await numericPeer(chatId);
    const entity: any = await client.getEntity(peer as any);
    active.throwIfAborted();
    const username = typeof entity?.username === "string" ? entity.username : undefined;
    const title = entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") || chatId;
    const rows: MessageData[] = [];
    const options: Record<string, unknown> = {limit: Math.min(800, count * 3)};
    if (beforeId) options.maxId = beforeId;
    for await (const item of client.iterMessages(entity, options)) {
      active.throwIfAborted();
      if (beforeId && item.id >= beforeId) continue;
      const content = typeof item.message === "string" ? item.message.trim() : "";
      const fileName = extractFileName(item);
      if (!content && !fileName) continue;
      const senderEntity: any = item.sender;
      const sender = senderEntity?.title || [senderEntity?.firstName, senderEntity?.lastName].filter(Boolean).join(" ") ||
        item.senderId?.toString() || "未知发送者";
      rows.push({text: `[${sender}] ${content || fileName}`, content, telegramLink: buildMessageLink(chatId, item.id, username),
        urls: extractUrlsFromEntities(item), ...(fileName ? {fileName} : {})});
      if (rows.length >= count) break;
    }
    rows.reverse();
    return {data: rows, title: String(title)};
  });
}

async function summarize(ctx: PluginContext, task: Pick<SummaryTask, "chatId" | "messageCount" | "aiProvider" | "aiPrompt" | "useSpoiler">,
  beforeId?: number, signal: AbortSignal = ctx.signal): Promise<{html: string; title: string}> {
  await migrateAi(ctx);
  const db = await store(ctx).read(signal);
  requireValue(ctx.services.available("ai", "chat"), "请先安装 ai 插件并配置聊天模型");
  const messages = await readMessages(ctx, task.chatId, beforeId, task.messageCount, signal);
  requireValue(messages.data.length, "未找到可总结的消息");
  ctx.log.info("sum:request", {messages: messages.data.length, inputChars: messages.data.reduce((n, item) => n + item.content.length, 0)});
  let output = await ctx.services.call<string>("ai", "chat", {text:formatMessagesForAI(messages.data),
    systemPrompt:task.aiPrompt || db.aiConfig.default_prompt || DEFAULT_PROMPT, maxOutputTokens:2000,
    ...(task.aiProvider ? {tag:task.aiProvider} : {})}, signal);
  output = output.replace(/<thinking>[\s\S]*?<\/thinking>|<think>[\s\S]*?<\/think>/gi, "").trim();
  const limit = db.aiConfig.max_output_length ?? 0;
  if (limit > 0 && output.length > limit) output = `${output.slice(0, limit)}\n\n内容已按配置长度截断。`;
  if (task.useSpoiler === true && !output.includes("<blockquote expandable>")) output = `<blockquote expandable>${output}</blockquote>`;
  return {html: `📊 <b>群组总结</b>\n${htmlEscape(messages.title)} · ${formatDate(new Date())}\n\n${output}`, title: messages.title};
}

async function sendPages(ctx: PluginContext, message: MessageEnvelope, html: string): Promise<void> {
  const pages = htmlPages(html);
  for (let index = 0; index < pages.length; index++) {
    ctx.signal.throwIfAborted();
    if (!index) await ctx.telegram.edit(message, pages[index], {parseMode: "html", linkPreview: false});
    else await ctx.telegram.reply(message, pages[index], {parseMode: "html", linkPreview: false});
  }
}

async function pushSummary(ctx: PluginContext, task: SummaryTask, signal: AbortSignal): Promise<void> {
  const result = await summarize(ctx, task, undefined, signal);
  signal.throwIfAborted();
  const db = await store(ctx).read(signal);
  const target = task.pushTarget || db.defaultPushTarget || "me";
  await ctx.telegram.withClient(async (client, active) => {
    for (const page of htmlPages(result.html)) {
      active.throwIfAborted(); await client.sendMessage(target, {message: page, parseMode: "html", linkPreview: db.aiConfig.link_preview === true});
    }
  });
}

export default function createSum() {
  const disposers = new Map<string, () => Promise<void>>();
  const running = new Set<string>();
  const register = async (ctx: PluginContext, task: SummaryTask): Promise<void> => {
    if (task.disabled || disposers.has(task.id)) return;
    const dispose = await ctx.jobs.register(`task-${task.id}`, {cron: task.cron, description: `群消息总结 ${task.id}`}, async signal => {
      if (running.has(task.id)) return;
      running.add(task.id);
      try {
        await pushSummary(ctx, task, signal);
        await store(ctx).update(data => { const current = data.tasks.find(item => item.id === task.id); if (current) {
          current.lastRunAt = new Date().toISOString(); current.lastResult = "总结已发送"; delete current.lastError;
        } return data; }, signal);
      } catch {
        ctx.log.error("sum:scheduled-failed", {taskId: task.id});
        if (!signal.aborted) await store(ctx).update(data => { const current = data.tasks.find(item => item.id === task.id); if (current) {
          current.lastRunAt = new Date().toISOString(); current.lastError = "总结执行失败";
        } return data; }, signal);
      } finally { running.delete(task.id); }
    });
    disposers.set(task.id, dispose);
  };

  const guarded = (operation: CommandDefinition["handle"]): CommandDefinition["handle"] => async (invocation, ctx) => {
    try { await operation(invocation, ctx); }
    catch (error) { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `❌ ${error instanceof UserError ? error.message : "摘要操作失败，请检查配置、权限和网络后重试"}`); }
  };
  const configured = (operation: (i: CommandInvocation, ctx: PluginContext, db: SummaryDB) => Promise<void>): CommandDefinition["handle"] => guarded(async (i, ctx) => {
    const db = await store(ctx).read(ctx.signal);
    await operation(i, ctx, db);
  });
  const confirmed = async (i: CommandInvocation, ctx: PluginContext) => { await ctx.telegram.edit(i.message, "✅ 摘要配置已更新"); };
  const configList = configured(async (invocation, ctx, db) => {
      await migrateAi(ctx);
      let selected = "请先安装并配置 ai 插件";
      if (ctx.services.available("ai", "selection")) {
        const value = await ctx.services.call<{chat?:{tag?:string;model?:string}}>("ai", "selection", null, ctx.signal);
        selected = `${value.chat?.tag || "-"} / ${value.chat?.model || "-"}`;
      }
      await ctx.telegram.edit(invocation.message, `<b>摘要配置</b>\nAI：<code>${htmlEscape(selected)}</code>\n提示词：${db.aiConfig.default_prompt === DEFAULT_PROMPT || !db.aiConfig.default_prompt ? "内置" : "自定义"}\n链接预览：${db.aiConfig.link_preview ? "on" : "off"}`, {parseMode: "html"});
      return;
  });
  const switchSetting = (field: "link_preview" | "default_spoiler", value: boolean): CommandDefinition["handle"] => configured(async (i, ctx) => {
    await store(ctx).update(data => { data.aiConfig[field] = value; return data; }, ctx.signal); await confirmed(i, ctx);
  });
  const switches = (field: "link_preview" | "default_spoiler"): SubcommandDefinition => ({
    description: field === "link_preview" ? "设置定时推送链接预览，默认关闭" : "设置回答折叠，默认关闭",
    subcommands: {on: {description: "开启", args: "", handle: switchSetting(field, true)}, off: {description: "关闭", args: "", handle: switchSetting(field, false)}},
    handle: configured(async () => { throw new UserError("请输入 on 或 off"); }),
  });
  const prompt = (reset: boolean): CommandDefinition["handle"] => configured(async (i, ctx) => {
    const value = reset ? DEFAULT_PROMPT : i.args.join(" ").trim(); requireValue(value, "提示词不能为空");
    await store(ctx).update(data => { data.aiConfig.default_prompt = value; return data; }, ctx.signal); await confirmed(i, ctx);
  });
  const centralConfig: CommandDefinition["handle"] = async (invocation, ctx) => {
    await ctx.telegram.edit(invocation.message,
      `供应商、密钥、模型、思考强度与服务等级由 ai 插件统一管理，请使用 ${invocation.prefix}ai config、${invocation.prefix}ai model chat、${invocation.prefix}ai reasoning chat 和 ${invocation.prefix}ai service chat。`);
  };
  const manageTask = (sub: "run" | "del" | "disable" | "enable"): CommandDefinition["handle"] => guarded(async (invocation, ctx) => {
        const id = invocation.args[0] ?? ""; const db = await store(ctx).read(ctx.signal);
        const task = db.tasks.find(item => item.id === id); requireValue(task, "摘要任务不存在");
        if (sub === "run") { await ctx.telegram.edit(invocation.message, "📝 正在生成摘要..."); await pushSummary(ctx, task, ctx.signal); await ctx.telegram.edit(invocation.message, "✅ 摘要已推送"); return; }
        if (sub === "del" || sub === "disable") { const dispose = disposers.get(id); if (dispose) { await dispose(); disposers.delete(id); } }
        await store(ctx).update(data => { const index = data.tasks.findIndex(item => item.id === id);
          if (sub === "del") data.tasks.splice(index, 1); else data.tasks[index].disabled = sub === "disable"; return data; }, ctx.signal);
        if (sub === "enable") await register(ctx, {...task, disabled: false});
        await ctx.telegram.edit(invocation.message, "✅ 摘要任务已更新"); return;

  });
  const command: CommandDefinition = {
    description: "群消息即时与定时摘要", helpArgs: ["help", "h", "?"], args: "[消息数] [--provider ai标签]", subcommandsCaseSensitive: false,
    examples: [{args: "", description: "总结当前群最近 100 条消息"}, {args: "200"}, {args: "100 --provider main"}],
    subcommands: {
      list: {description: "查看定时摘要任务", args: "", handle: guarded(async (invocation, ctx) => {
        const db = await store(ctx).read(ctx.signal);
        const text = db.tasks.map(task => `• <code>${htmlEscape(task.id)}</code> · ${htmlEscape(task.interval)} · ${task.messageCount} 条 · ${task.disabled ? "停用" : "启用"}`).join("\n") || "暂无定时任务";
        await ctx.telegram.edit(invocation.message, `<b>摘要任务</b>\n${text}`, {parseMode: "html"}); return;

      })},
      run: {description: "立即执行任务并推送", args: "ID", handle: manageTask("run")},
      del: {description: "删除任务", args: "ID", handle: manageTask("del")},
      disable: {description: "暂停任务", args: "ID", handle: manageTask("disable")},
      enable: {description: "恢复任务", args: "ID", handle: manageTask("enable")},
      add: {description: "创建定时摘要，推送到收藏夹", args: "here|群组 间隔 [消息数]", examples: [{args: "add here 2h 100"}, {args: "add here 30m 200"}], help: [{heading: "间隔：", body: "分钟间隔为 1–59 且能整除 60；小时间隔为 1–23 且能整除 24；按天仅支持 1d。消息数默认 100，范围 10–500。"}], handle: guarded(async (invocation, ctx) => {
        const target = invocation.args[0] ?? "", interval = invocation.args[1] ?? "", count = Number(invocation.args[2] ?? 100);
        requireValue(target && Number.isSafeInteger(count) && count >= 10 && count <= 500, "用法：sum add here|群组 2h 100");
        const chatId = target === "here" ? invocation.message.chatId : target;
        const cron = intervalCron(interval);
        const db = await store(ctx).read(ctx.signal); const id = String(Number(db.seq || "0") + 1);
        const task: SummaryTask = {id, cron, chatId, interval, messageCount: count, pushTarget: "me", createdAt: new Date().toISOString(),
          useSpoiler: db.aiConfig.default_spoiler === true};
        await store(ctx).update(data => { data.seq = id; data.tasks.push(task); return data; }, ctx.signal);
        try { await register(ctx, task); } catch (error) {
          await store(ctx).update(data => { data.tasks = data.tasks.filter(item => item.id !== id); data.seq = db.seq; return data; }, ctx.signal); throw error;
        }
        await ctx.telegram.edit(invocation.message, `✅ 已创建摘要任务 ${id}`); return;

      })},
      config: {description: "查看统一 AI 选择与摘要设置", args: "", subcommandsCaseSensitive: true, defaultSubcommand: "list", subcommands: {
        list: {description: "查看当前统一 AI 选择及摘要显示配置", args: "", handle: configList},
        add: {description: "查看统一 AI 配置方式", args: "", handle: centralConfig},
        del: {description: "查看统一 AI 配置方式", args: "", handle: centralConfig},
        set: {description: "修改摘要显示，或查看统一 AI 配置方式", args: "preview|spoiler|prompt ...", subcommands: {
          default: {description: "查看统一 AI 配置方式", handle: centralConfig},
          preview: switches("link_preview"), spoiler: switches("default_spoiler"),
          reasoning: {description: "查看统一 AI 配置方式", handle: centralConfig},
          service: {description: "查看统一 AI 配置方式", handle: centralConfig},
          prompt: {description: "设置默认摘要提示词", args: "内容", subcommands: {
            show: {description: "查看当前实际提示词", args: "", handle: configured(async (i, ctx, db) => { await ctx.telegram.edit(i.message, `<b>当前摘要提示词</b>\n\n<code>${htmlEscape(db.aiConfig.default_prompt || DEFAULT_PROMPT)}</code>`, {parseMode: "html"}); })},
            reset: {description: "恢复内置详细版提示词", args: "", handle: prompt(true)},
          }, handle: prompt(false)},
        }, handle: centralConfig},
      }, handle: configured(async () => { throw new UserError("未知 config 子命令"); })},
    },
    help: [{heading: "即时与定时：", body: "即时总结默认取当前群命令之前的最近 100 条，范围 10–500；可用 --provider 临时指定 ai 插件中的标签。定时任务默认发往收藏夹。长结果自动分段；即时结果关闭链接预览，定时结果按 preview 配置。"},
      {heading: "AI 配置：", body: "供应商、密钥、聊天模型、思考强度、服务等级和超时由 ai 插件统一管理；sum 仅保留摘要提示词与显示设置。"}],
    handle: guarded(async (invocation, ctx) => {
      const sub = invocation.args[0]?.toLowerCase() ?? "";
      if (["help", "h", "?"].includes(sub)) { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
      const count = sub && /^\d+$/.test(sub) ? Number(sub) : 100;
      requireValue(Number.isSafeInteger(count) && count >= 10 && count <= 500, "消息数量范围为 10-500");
      const providerAt = invocation.args.indexOf("--provider");
      const provider = providerAt >= 0 ? invocation.args[providerAt + 1] : undefined;
      await ctx.telegram.edit(invocation.message, "📝 正在生成群聊摘要...");
      const db = await store(ctx).read(ctx.signal);
      const result = await summarize(ctx, {chatId: invocation.message.chatId, messageCount: count, aiProvider: provider,
        useSpoiler: db.aiConfig.default_spoiler === true}, invocation.message.id);
      await sendPages(ctx, invocation.message, result.html);

    }),
  };
  const help = (prefix: string) => renderCommandHelp("sum", command, {prefix, title: "📊 群消息总结"});

  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "sum", description: "群消息即时与定时摘要", commands: {sum: command},
    async setup(ctx) {
      await store(ctx).update(data => {
        const value = data as any;
        if (typeof value.seq !== "string") value.seq = String(value.seq ?? "0");
        if (!Array.isArray(value.tasks)) value.tasks = [];
        if (!value.aiConfig || typeof value.aiConfig !== "object" || Array.isArray(value.aiConfig)) value.aiConfig = {...defaults.aiConfig, providers: {}};
        if (!value.aiConfig.providers || typeof value.aiConfig.providers !== "object" || Array.isArray(value.aiConfig.providers)) value.aiConfig.providers = {};
        if (value.aiConfig.aiMigrated !== true && Object.keys(value.aiConfig.providers).length === 0) value.aiConfig.aiMigrated = true;
        if (value.aiConfig.aiMigrated === true) scrubLegacyAiSettings(value.aiConfig);
        return data;
      }, ctx.signal);
      await migrateAi(ctx);
      const db = await store(ctx).read(ctx.signal); for (const task of db.tasks) {
      try { await register(ctx, task); } catch { ctx.log.error("sum:register-failed", {taskId: task.id}); }
      }
    },
    async cleanup() { disposers.clear(); running.clear(); },
  });
}
