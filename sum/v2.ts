import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, type SubcommandDefinition, definePlugin, type CommandInvocation, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {
  buildMessageLink, DEFAULT_PROMPT, extractFileName, extractUrlsFromEntities, formatDate,
  formatMessagesForAI, htmlEscape, normalizeReasoningEffort, normalizeServiceTier,
  type CustomProvider, type MessageData, type SummaryDB, type SummaryTask,
} from "./v2/model";
import {htmlPages} from "./v2/output";
import {callAI} from "./v2/provider";

const defaults: SummaryDB = {seq: "0", tasks: [], aiConfig: {providers: {},
  default_prompt: DEFAULT_PROMPT, default_spoiler: false, default_timeout: 60_000,
  default_reasoning_effort: "auto", default_service_tier: "auto", reply_mode: false,
  max_output_length: 0, link_preview: false}};
class UserError extends Error {}
const requireValue: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new UserError(message);
};
const store = (ctx: PluginContext) => ctx.storage.json<SummaryDB>("database.json", defaults);
const assertAllowedModel = (model: string): void => {
  if (/^gpt-5\.6-(?:luna|terra)(?:$|[-/])/i.test(model.trim())) throw new UserError("该模型不可用于此项目");
};
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

function providerView(provider: CustomProvider): string {
  return `${htmlEscape(provider.name)} · <code>${htmlEscape(provider.model)}</code> · ${htmlEscape(provider.type ?? "auto")}`;
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
  const db = await store(ctx).read(signal);
  const providerName = task.aiProvider || db.aiConfig.default_provider || "";
  const provider = db.aiConfig.providers[providerName];
  requireValue(providerName && provider, "请先用 sum config add 添加 AI 配置并设置默认提供商");
  requireValue(provider.api_key, "默认 AI 配置缺少 API Key");
  const messages = await readMessages(ctx, task.chatId, beforeId, task.messageCount, signal);
  requireValue(messages.data.length, "未找到可总结的消息");
  ctx.log.info("sum:request", {messages: messages.data.length, inputChars: messages.data.reduce((n, item) => n + item.content.length, 0)});
  let output = await callAI(ctx, provider, formatMessagesForAI(messages.data), task.aiPrompt || db.aiConfig.default_prompt || DEFAULT_PROMPT,
    normalizeReasoningEffort(db.aiConfig.default_reasoning_effort), normalizeServiceTier(db.aiConfig.default_service_tier),
    db.aiConfig.default_timeout || 60_000, signal);
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
  const configured = (operation: (i: CommandInvocation, ctx: PluginContext, db: SummaryDB) => Promise<void>, secret = false): CommandDefinition["handle"] => guarded(async (i, ctx) => {
    const db = await store(ctx).read(ctx.signal);
    const setPath = i.subcommands?.[0] === "config" && i.subcommands[1] === "set";
    const property = i.subcommands && i.subcommands.length > 2 ? i.subcommands[3] ?? i.args[0] : i.args[1];
    if (secret || setPath && property === "key") requireValue(i.message.saved, "涉及 API Key 的配置命令只能在收藏夹使用");
    await operation(i, ctx, db);
  });
  const confirmed = async (i: CommandInvocation, ctx: PluginContext) => { await ctx.telegram.edit(i.message, "✅ 摘要配置已更新"); };
  const configList = configured(async (invocation, ctx, db) => {
      const providers = Object.entries(db.aiConfig.providers).map(([key, value]) => `• <code>${htmlEscape(key)}</code>${db.aiConfig.default_provider === key ? "（默认）" : ""} · ${providerView(value)}`).join("\n") || "• 尚未配置 AI";
      await ctx.telegram.edit(invocation.message, `<b>摘要 AI 配置</b>\n${providers}\n\n提示词：${db.aiConfig.default_prompt === DEFAULT_PROMPT || !db.aiConfig.default_prompt ? "内置" : "自定义"}\n链接预览：${db.aiConfig.link_preview ? "on" : "off"}`, {parseMode: "html"});
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
  const selectOption = (kind: "reasoning" | "service"): CommandDefinition["handle"] => configured(async (i, ctx) => {
    const property = i.args[0] ?? "";
    const normalized = kind === "reasoning" ? normalizeReasoningEffort(property) : normalizeServiceTier(property);
    requireValue(normalized === property, "无效选项");
    await store(ctx).update(data => { if (kind === "reasoning") data.aiConfig.default_reasoning_effort = normalized as any;
      else data.aiConfig.default_service_tier = normalized as any; return data; }, ctx.signal); await confirmed(i, ctx);
  });
  const prompt = (reset: boolean): CommandDefinition["handle"] => configured(async (i, ctx) => {
    const value = reset ? DEFAULT_PROMPT : i.args.join(" ").trim(); requireValue(value, "提示词不能为空");
    await store(ctx).update(data => { data.aiConfig.default_prompt = value; return data; }, ctx.signal); await confirmed(i, ctx);
  });
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
    description: "群消息即时与定时摘要", helpArgs: ["help", "h", "?"], args: "[消息数] [--provider 名称]", subcommandsCaseSensitive: false,
    examples: [{args: "", description: "总结当前群最近 100 条消息"}, {args: "200"}, {args: "100 --provider myai"}],
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
          ...(db.aiConfig.default_provider ? {aiProvider: db.aiConfig.default_provider} : {}), useSpoiler: db.aiConfig.default_spoiler === true};
        await store(ctx).update(data => { data.seq = id; data.tasks.push(task); return data; }, ctx.signal);
        try { await register(ctx, task); } catch (error) {
          await store(ctx).update(data => { data.tasks = data.tasks.filter(item => item.id !== id); data.seq = db.seq; return data; }, ctx.signal); throw error;
        }
        await ctx.telegram.edit(invocation.message, `✅ 已创建摘要任务 ${id}`); return;

      })},
      config: {description: "查看和修改摘要 AI 配置", args: "", subcommandsCaseSensitive: true, defaultSubcommand: "list", subcommands: {
        list: {description: "查看供应商、模型、接口类型、默认配置及链接预览", args: "", handle: configList},
        add: {description: "添加 AI 配置，仅收藏夹", args: "名称 BaseURL API_KEY 模型 [auto|chat|responses|gemini|anthropic]", examples: [{args: "add myai https://api.example.com YOUR_KEY gpt-4o"}], help: [{body: "未指定类型时自动识别：GPT-5/o 系列使用 Responses，Gemini 使用 Gemini API，Claude 使用 Anthropic Messages，其余使用 Chat Completions。"}], handle: configured(async (i, ctx) => {
          const [name = "", base = "", key = "", model = "", type = "auto"] = i.args;
          requireValue(name && base && key && model, "用法：sum config add 名称 BaseURL API_KEY 模型 [type]");
          new URL(base); assertAllowedModel(model); requireValue(["auto", "chat", "responses", "gemini", "anthropic"].includes(type), "无效接口类型");
          await store(ctx).update(data => { data.aiConfig.providers[name] = {name, base_url: base, api_key: key, model, type: type as CustomProvider["type"]}; data.aiConfig.default_provider ||= name; return data; }, ctx.signal);
          await confirmed(i, ctx);
        }, true)},
        del: {description: "删除 AI 配置，默认项同时清空", args: "名称", handle: configured(async (i, ctx, db) => {
          const name = i.args[0] ?? ""; requireValue(name && db.aiConfig.providers[name], "AI 配置不存在");
          await store(ctx).update(data => { delete data.aiConfig.providers[name]; if (data.aiConfig.default_provider === name) delete data.aiConfig.default_provider; return data; }, ctx.signal);
          await confirmed(i, ctx);
        })},
        set: {description: "修改全局设置或供应商字段", args: "名称 model|url|key|type 值", examples: [{args: "set myai model gpt-4o"}, {args: "set myai url https://api.example.com"}, {args: "set myai key YOUR_KEY"}, {args: "set myai type responses"}], subcommands: {
          default: {description: "选择默认 AI 配置", args: "名称", examples: [{args: "default myai"}], handle: configured(async (i, ctx, db) => {
            const name = i.args[0] ?? ""; requireValue(db.aiConfig.providers[name], "AI 配置不存在");
            await store(ctx).update(data => { data.aiConfig.default_provider = name; return data; }, ctx.signal); await confirmed(i, ctx);
          })},
          preview: switches("link_preview"), spoiler: switches("default_spoiler"),
          reasoning: {description: "设置 OpenAI 思考强度，auto 使用服务端默认值", args: "auto|none|minimal|low|medium|high|xhigh", handle: selectOption("reasoning")},
          service: {description: "设置 OpenAI 服务等级，auto 不发送该参数", args: "auto|default|priority|fast|flex", handle: selectOption("service")},
          prompt: {description: "设置默认摘要提示词", args: "内容", subcommands: {
            show: {description: "查看当前实际提示词", args: "", handle: configured(async (i, ctx, db) => { await ctx.telegram.edit(i.message, `<b>当前摘要提示词</b>\n\n<code>${htmlEscape(db.aiConfig.default_prompt || DEFAULT_PROMPT)}</code>`, {parseMode: "html"}); })},
            reset: {description: "恢复内置详细版提示词", args: "", handle: prompt(true)},
          }, handle: prompt(false)},
        }, help: [{body: "修改供应商 key 字段仅限收藏夹。供应商名称、字段名和 config 次级动作区分大小写。"}], handle: configured(async (i, ctx, db) => {
          const [name = "", property = "", ...rest] = i.args, value = rest.join(" ").trim();
          if (property === "key") requireValue(i.message.saved, "涉及 API Key 的配置命令只能在收藏夹使用");
          const provider = db.aiConfig.providers[name];
          requireValue(provider && ["model", "url", "key", "type"].includes(property) && value, "用法：sum config set 名称 model|url|key|type 值");
          if (property === "model") assertAllowedModel(value); if (property === "url") new URL(value);
          if (property === "type") requireValue(["auto", "chat", "responses", "gemini", "anthropic"].includes(value), "无效接口类型");
          await store(ctx).update(data => { const item = data.aiConfig.providers[name];
            if (property === "model") item.model = value; else if (property === "url") item.base_url = value;
            else if (property === "key") item.api_key = value; else item.type = value as CustomProvider["type"]; return data; }, ctx.signal); await confirmed(i, ctx);
        })},
      }, handle: configured(async () => { throw new UserError("未知 config 子命令"); })},
    },
    help: [{heading: "即时与定时：", body: "即时总结默认取当前群命令之前的最近 100 条，范围 10–500；可用 --provider 临时指定配置。定时任务默认发往收藏夹。长结果自动分段；即时结果关闭链接预览，定时结果按 preview 配置。"},
      {heading: "供应商与密钥：", body: "先添加供应商并设置默认项。涉及 API Key 的命令仅限收藏夹；模型需符合项目支持范围。"}],
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
        return data;
      }, ctx.signal);
      const db = await store(ctx).read(ctx.signal); for (const task of db.tasks) {
      try { await register(ctx, task); } catch { ctx.log.error("sum:register-failed", {taskId: task.id}); }
      }
    },
    async cleanup() { disposers.clear(); running.clear(); },
  });
}
