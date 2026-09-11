import {readFile} from "node:fs/promises";
import {
  STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp,
  type CommandDefinition, type CommandInvocation, type PluginContext,
} from "telebox/sdk";

type ProviderType = "openai" | "gemini";
type LegacyProvider = {name: string; baseUrl: string; apiKey: string; model: string; type: ProviderType};
type State = {
  schemaVersion: 2; providers: Record<string, LegacyProvider>; defaultProvider: string | null;
  prompts: Record<string, string>; collapse: boolean; legacyImported: boolean; aiMigrated: boolean;
  [key: string]: unknown;
};
const DEFAULTS: State = {schemaVersion: 2, providers: {}, defaultProvider: null, prompts: {}, collapse: true,
  legacyImported: false, aiMigrated: false};
const BUILTIN: Readonly<Record<string, string>> = {
  zj: "请总结以下消息的主要内容，提取关键信息，用简洁的中文回复：",
  fx: "请分析以下消息的观点、态度和倾向，用简洁的中文回复：",
};
const store = (context: PluginContext) => context.storage.json<State>("v2-config.json", DEFAULTS);
const esc = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[character]!);

function provider(value: unknown, name?: string): LegacyProvider | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  const type = item.type === "gemini" ? "gemini" : item.type === "openai" ? "openai" : undefined;
  const baseUrl = item.baseUrl ?? item.base_url; const apiKey = item.apiKey ?? item.api_key;
  if (!type || typeof baseUrl !== "string" || typeof apiKey !== "string" || typeof item.model !== "string") return;
  const result: LegacyProvider = {name: String(item.name ?? name ?? "").slice(0, 64), baseUrl, apiKey, model: item.model.slice(0, 200), type};
  if (!result.name || !result.baseUrl || !result.apiKey || !result.model) return;
  try { const url = new URL(result.baseUrl); if (url.protocol !== "https:" || url.username || url.password) return; }
  catch { return; }
  return result;
}
function normalize(raw: unknown): State {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const providers: Record<string, LegacyProvider> = {};
  if (value.providers && typeof value.providers === "object") for (const [name, item] of Object.entries(value.providers)) {
    const parsed = provider(item, name); if (parsed) providers[name] = parsed;
  }
  const prompts: Record<string, string> = {};
  if (value.prompts && typeof value.prompts === "object") for (const [name, prompt] of Object.entries(value.prompts)) {
    if (/^[\w-]{1,32}$/u.test(name) && typeof prompt === "string" && prompt.length <= 10_000) prompts[name] = prompt;
  }
  const defaultName = String(value.defaultProvider ?? value.default_provider ?? "");
  return {...value, schemaVersion: 2, providers, defaultProvider: providers[defaultName] ? defaultName : Object.keys(providers)[0] ?? null,
    prompts, collapse: value.collapse !== false, legacyImported: value.legacyImported === true, aiMigrated: value.aiMigrated === true};
}
async function readState(context: PluginContext): Promise<State> {
  let current = normalize(await store(context).read());
  if (!current.legacyImported) {
    try {
      const legacy = normalize(JSON.parse(await context.tasks.run("uai:legacy-read", () => readFile(context.files.dataPath("config.json"), "utf8"))));
      current = normalize({...current, ...legacy, providers: {...legacy.providers, ...current.providers}, prompts: {...legacy.prompts, ...current.prompts}});
    } catch { /* an absent legacy file is expected */ }
    current.legacyImported = true;
    current = await store(context).update(() => current);
  }
  return normalize(current);
}
function providerUrl(item: LegacyProvider): string {
  const url = new URL(item.baseUrl); let pathname = url.pathname.replace(/\/+$/, ""); url.search = ""; url.hash = "";
  if (item.type === "gemini") {
    if (!/\/v1beta$/i.test(pathname)) pathname += "/v1beta";
  } else if (!/\/v\d+$/i.test(pathname)) pathname += "/v1";
  url.pathname = pathname;
  return url.toString();
}
async function migrateAi(context: PluginContext): Promise<State> {
  const current = await readState(context);
  if (current.aiMigrated) return current;
  const entries = Object.entries(current.providers).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return store(context).update(value => ({...normalize(value), providers: {}, defaultProvider: null, aiMigrated: true}));
  if (!context.services.available("ai", "import_provider")) return current;
  for (let index = 0; index < entries.length; index++) {
    const [name, item] = entries[index]!; const tag = `uai-${index + 1}`;
    await context.services.call("ai", "import_provider", {tag, url: providerUrl(item), key: item.apiKey,
      type: item.type === "gemini" ? "gemini" : "openai-compatible", models: {chat: item.model},
      select: name === current.defaultProvider ? ["chat"] : []}, context.signal);
  }
  try {await context.storage.json<Record<string,unknown>>("config.json", {}).update(value =>
    ({...value, providers:{}, default_provider:null, defaultProvider:null}), context.signal);} catch {}
  return store(context).update(value => ({...normalize(value), providers: {}, defaultProvider: null, aiMigrated: true}));
}

const id = (value: any): string => value == null ? "" : typeof value === "object" ? id(value.userId ?? value.channelId ?? value.chatId ?? value.value) : String(value);
function limit(args: readonly string[]) {
  let result: {kind:"count"; value:number} | {kind:"time"; value:number} | {kind:"today"} = {kind:"today"};
  for (const arg of args) if (/^\d+$/u.test(arg)) result = {kind:"count", value: Math.min(500, Math.max(1, Number(arg)))};
  else { const match = /^(\d+)([hm])$/iu.exec(arg); if (match) result = {kind:"time", value: Math.min(7 * 86400, Number(match[1]) * (match[2].toLowerCase() === "h" ? 3600 : 60))}; }
  return result;
}
async function collect(context: PluginContext, peer: any, sender: string | null, rule: ReturnType<typeof limit>): Promise<string[]> {
  return context.telegram.withClient(async client => {
    const now = Math.floor(Date.now() / 1000);
    const start = rule.kind === "today" ? new Date().setHours(0, 0, 0, 0) / 1000 : rule.kind === "time" ? now - rule.value : 0;
    const maximum = rule.kind === "count" ? rule.value : 500; const options: any = {limit: sender ? Math.min(maximum * 20, 3000) : maximum};
    if (sender) try { options.fromUser = await client.getEntity(sender); } catch { /* compare IDs while iterating */ }
    const output: string[] = []; let characters = 0;
    for await (const value of client.iterMessages(peer, options)) {
      context.signal.throwIfAborted(); const message: any = value;
      if (rule.kind !== "count" && Number(message.date) < start) break;
      if (sender && !options.fromUser && id(message.senderId) !== sender) continue;
      if (typeof message.message !== "string" || !message.message || /^📊 (分析|总结)结果/u.test(message.message)) continue;
      const who = String(message.sender?.firstName ?? message.sender?.username ?? "未知");
      const line = `[${new Date(Number(message.date) * 1000).toISOString().slice(0, 16).replace("T", " ")}] ${who}: ${message.message}`;
      if (characters + line.length > 100_000) break; characters += line.length; output.push(line);
      if (output.length >= maximum) break;
    }
    return output.reverse();
  });
}

const guarded = (operation: (invocation: CommandInvocation, context: PluginContext, state: State,
  edit: (text: string, html?: boolean) => Promise<void>) => Promise<void>): CommandDefinition["handle"] => async (invocation, context) => {
  const edit = (text: string, html = false) => context.telegram.edit(invocation.message, text, html ? {parseMode: "html", linkPreview: false} : {});
  try {
    if (!invocation.subcommand && (!invocation.args[0] || invocation.args[0] === "help" || invocation.args[0] === "h")) { await edit(help(invocation.prefix), true); return; }
    await operation(invocation, context, await migrateAi(context), edit);
  } catch { if (!context.signal.aborted) { context.log.error("uai_failed"); await edit("UAI 执行失败，请检查引用消息、ai 配置和网络"); } }
};
const analyze = (selectedPrompt?: string): CommandDefinition["handle"] => guarded(async (invocation, context, state, edit) => {
  const reply = await context.telegram.getReply(invocation.message); if (!reply) throw new Error("请引用一条消息");
  const raw: any = invocation.message.raw, replyRaw: any = reply.raw; if (!raw?.peerId || !replyRaw) throw new Error("消息上下文不可用");
  let source: string | null = id(replyRaw.senderId), peer: any = raw.peerId, name = String(replyRaw.sender?.firstName ?? replyRaw.sender?.username ?? "用户");
  const forwarded = replyRaw.fwdFrom?.fromId;
  if (forwarded?.channelId) {source = null; peer = `-100${id(forwarded.channelId)}`; name = "频道";}
  else if (forwarded?.userId) source = id(forwarded.userId);
  if (!source && !forwarded?.channelId) throw new Error("无法确定消息来源");
  const key = selectedPrompt ?? invocation.args[0]; const promptKey = Object.hasOwn(BUILTIN, key) || Object.hasOwn(state.prompts, key) ? key : "zj";
  const messages = await collect(context, peer, source, limit(invocation.args)); if (!messages.length) throw new Error("没有找到消息");
  if (!context.services.available("ai", "chat")) throw new Error("请先安装 ai 插件");
  await edit("正在分析消息…");
  const result = await context.services.call<string>("ai", "chat", {text: `${name}\n\n${messages.join("\n")}`,
    systemPrompt: state.prompts[promptKey] ?? BUILTIN[promptKey] ?? BUILTIN.zj, maxOutputTokens: 4096}, context.signal);
  const points = Array.from(result), content = esc(points.length > 3000 ? `${points.slice(0, 3000).join("")}\n…（输出已截断）` : result);
  await edit(`📊 <b>${promptKey === "fx" ? "分析" : "总结"}结果</b>（${esc(name)}，${messages.length} 条）\n\n${state.collapse ? `<blockquote expandable>${content}</blockquote>` : content}`, true);
});
const promptChange = (adding: boolean): CommandDefinition["handle"] => guarded(async (invocation, context, _state, edit) => {
  const [name, ...words] = invocation.args;
  if (!name || BUILTIN[name]) throw new Error("提示词名称无效");
  const prompt = words.join(" ");
  if (adding && !prompt) throw new Error("用法：prompt add|del|list");
  await store(context).update(value => {
    const current = normalize(value);
    const prompts = {...current.prompts};
    if (adding) prompts[name] = prompt.slice(0, 10_000); else delete prompts[name];
    return {...current, prompts, legacyImported: true};
  });
  await edit("提示词已更新");
});
const collapse = (enabled: boolean): CommandDefinition["handle"] => guarded(async (_invocation, context, state, edit) => {
  await store(context).update(value => ({...normalize(value), collapse: enabled, aiMigrated: state.aiMigrated, legacyImported: true})); await edit("折叠设置已更新");
});
const central: CommandDefinition["handle"] = guarded(async (invocation, _context, _state, edit) => {
  await edit(`供应商、密钥和模型由 ai 插件统一管理，请使用 ${invocation.prefix}ai config 与 ${invocation.prefix}ai model chat。`);
});
const command: CommandDefinition = {
  description: "使用统一 AI 服务汇总或分析引用来源", helpArgs: ["help", "h"], helpOnEmpty: true,
  args: "自定义提示词名 [数量|时间]", subcommandsCaseSensitive: true,
  subcommands: {
    zj: {description: "总结引用来源消息，提取关键信息", args: "[数量|时间]", examples: [{args:"zj"},{args:"zj 50"}], handle: analyze("zj")},
    fx: {description: "分析引用来源消息的观点和态度", args: "[数量|时间]", examples: [{args:"fx 100"},{args:"fx 2h"}], handle: analyze("fx")},
    add: {description: "查看统一 AI 配置方式", handle: central}, del: {description: "查看统一 AI 配置方式", handle: central},
    set: {description: "查看统一 AI 配置方式", handle: central}, model: {description: "查看统一 AI 配置方式", handle: central},
    list: {description: "查看统一 AI 配置方式", handle: central},
    collapse: {description: "设置回答折叠，默认开启", subcommands: {
      on: {description:"开启折叠", handle: collapse(true)}, off: {description:"关闭折叠", handle: collapse(false)},
    }, handle: guarded(async () => {throw new Error("用法：collapse on|off");})},
    prompt: {description: "管理自定义提示词", subcommands: {
      add: {description:"添加或更新提示词", args:"名称 内容", handle: promptChange(true)},
      del: {description:"删除自定义提示词", args:"名称", handle: promptChange(false)},
      list: {description:"列出内置和自定义提示词", handle: guarded(async (_i, _c, state, edit) => edit([...Object.keys(BUILTIN), ...Object.keys(state.prompts)].join("\n")))},
    }, handle: guarded(async () => {throw new Error("用法：prompt add|del|list");})},
  },
  help: [
    {heading:"引用与范围：", body:"先引用用户消息，再用 zj 总结或 fx 分析；默认取服务器本地当天消息，支持 50 等数量或 2h/30m 等时间参数；最多 500 条、7 天和 100000 输入字符。"},
    {heading:"AI 配置：", body:"供应商、密钥、聊天模型和超时由 ai 插件统一管理；UAI 仅保留提示词与折叠设置。结果超过 3000 个 Unicode 字符时截断并说明。"},
  ],
  handle: analyze(),
};
const help = (prefix: string): string => renderCommandHelp("uai", command, {prefix, title: "⚙️ UAI 用户消息分析"});

export default function createUai() {
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "uai",
    description: "引用消息并使用统一 AI 服务汇总或分析历史消息", commands: {uai: command},
    settings: context => ({id:"uai", title:"UAI", description:"消息分析提示词与显示", category:"插件配置", icon:"🤖",
      getSchema: () => [{key:"prompts", label:"提示词", type:"prompt-map"}, {key:"collapse", label:"折叠输出", type:"boolean"}],
      async getValues() {const state = await migrateAi(context); return {prompts: state.prompts, collapse: state.collapse};},
      async setValues(patch) {
        await store(context).update(value => {
          const current = normalize(value); const prompts = patch.prompts === undefined ? current.prompts : patch.prompts;
          if (!prompts || typeof prompts !== "object" || Array.isArray(prompts)) throw new Error("提示词无效");
          const checked = normalize({...current, prompts, collapse: patch.collapse ?? current.collapse});
          return {...checked, providers: current.providers, defaultProvider: current.defaultProvider,
            legacyImported: current.legacyImported, aiMigrated: current.aiMigrated};
        });
      }}),
    async setup(context) {await migrateAi(context);},
  });
}
