import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, ui, type CommandDefinition, type CommandInvocation, type PluginContext} from "telebox/sdk";
import {readFile, stat} from "node:fs/promises";

type Config = {apiKey: string; apiUrl: string; model: string; prompt: string; prompts: Record<string, string>; temperature: number; aiMigrated?: boolean; sqliteMigrated?: boolean; providerMigrated?: boolean};

/** Original plugin default (the V2 short default had replaced this). */
const ORIGINAL_DEFAULT_PROMPT =
  "You are an expert in Chinese-English translation, translating user input from Chinese to colloquial English. Users can send content that needs to be translated to the assistant, and the assistant will provide the corresponding translation results, ensuring that they conform to Chinese language conventions. You can adjust the tone and style, taking into account the cultural connotations and regional differences of certain words. As a translator, you need to translate the original text into a translation that meets the standards of accuracy and elegance. Only output the translated content!!!";
const DEFAULT_API_URL = "https://api.openai.com";
const DEFAULT_MODEL = "gpt-4o-mini";const DEFAULT_TEMPERATURE = 0.2;

const defaults: Config = {
  apiKey: "",
  apiUrl: "",
  model: "",
  prompt: ORIGINAL_DEFAULT_PROMPT,
  prompts: {},
  temperature: DEFAULT_TEMPERATURE, aiMigrated: false, sqliteMigrated: false, providerMigrated: false,
};

/** Original reserved aliases plus every declared subcommand name/alias, help/h and the command id. */
const RESERVED = new Set([
  "apikey", "key", "api", "url", "model", "prompt", "temp", "temperature", "info", "spn",
  "_set_key", "_set_api", "_set_url", "_set_model", "_set_prompt", "_set_temperature", "_info",
  "help", "h", "aitc",
]);

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);
function store(context: PluginContext) { return context.storage.json<Config>("config.json", defaults); }
function endpoint(base: string): URL {
  const value = new URL(base);
  if (!/^https?:$/.test(value.protocol) || value.username || value.password) throw new Error("Invalid API URL");
  value.pathname = `${value.pathname.replace(/\/+$/, "")}/v1/chat/completions`;
  value.search = ""; value.hash = "";
  return value;
}
function migrateBase(apiUrl: string): string {
  const value = new URL(apiUrl);
  if (!/^https?:$/.test(value.protocol) || value.username || value.password) throw new Error("Invalid API URL");
  let pathname = value.pathname.replace(/\/+$/, "")
    .replace(/\/v1\/chat\/completions$/, "").replace(/\/chat\/completions$/, "");
  // Mirror the ai plugin's openai base normalization so a retry matches the stored provider.
  if (pathname === "" || pathname === "/") pathname = "/v1";
  value.pathname = pathname;
  value.search = ""; value.hash = "";
  return value.toString().replace(/\/+$/, "");
}

function decodeCodePoint(value: number): string | undefined {
  // Reject non-integers, out-of-range values and lone surrogates; the caller keeps the literal.
  if (!Number.isInteger(value) || value < 0 || value > 0x10FFFF) return undefined;
  if (value >= 0xD800 && value <= 0xDFFF) return undefined;
  return String.fromCodePoint(value);
}

const decodeHtmlEntities = (text: string): string =>
  text
    .replace(/&#(\d+);/g, (match, code) => decodeCodePoint(Number.parseInt(code, 10)) ?? match)
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => decodeCodePoint(Number.parseInt(code, 16)) ?? match)
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
      switch (entity.toLowerCase()) {
        case "amp": return "&";
        case "lt": return "<";
        case "gt": return ">";
        case "quot": return "\"";
        case "apos": return "'";
        case "nbsp": return " ";
        default: return match;
      }
    });

/** Decode entities, strip control characters, normalize CRLF, never throw on invalid code points. */
function sanitizePlainText(text: string): string {
  return decodeHtmlEntities(String(text ?? ""))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n/g, "\n");
}

/** Raw tail after `count` leading whitespace-separated tokens, preserving internal spacing/newlines. */
function stripTokens(text: string, count: number): string {
  let rest = String(text ?? "").trimStart();
  for (let index = 0; index < count; index++) {
    const match = /^\S+\s*/.exec(rest);
    if (!match) return "";
    rest = rest.slice(match[0].length);
  }
  return rest;
}

interface LegacyConfig {apiKey?: string; apiUrl?: string; model?: string; prompt?: string; prompts?: Record<string, string>; temperature?: number}

/** Only a genuinely missing file means “no legacy DB”; corrupt/unreadable rows are retryable errors. */
async function readLegacyConfig(context: PluginContext): Promise<LegacyConfig | undefined> {
  let file: string;
  try { file = context.files.dataPath("aitc_config.db"); } catch { throw new Error("LEGACY_PATH"); }
  let info;
  try { info = await stat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined; throw new Error("LEGACY_STAT"); }
  if (!info.isFile()) throw new Error("LEGACY_NOT_FILE");
  let rows: {key: string; value: string}[];
  try {
    rows = await context.storage.sqlite("aitc_config.db", {mustExist: true}).read(connection =>
      connection.prepare("SELECT key, value FROM config").all() as {key: string; value: string}[]);
  } catch (error) {
    if (context.signal.aborted) throw error;
    throw new Error("LEGACY_UNREADABLE");
  }
  const map = new Map(rows.filter(row => row && typeof row.key === "string" && typeof row.value === "string")
    .map(row => [row.key, row.value] as const));
  const result: LegacyConfig = {};
  const key = map.get("aitc_api_key"); if (typeof key === "string" && key.length) result.apiKey = key;
  const url = map.get("aitc_api_url"); if (typeof url === "string" && url.length) result.apiUrl = url;
  const model = map.get("aitc_model"); if (typeof model === "string" && model.length) result.model = model;
  const prompt = map.get("aitc_prompt"); if (typeof prompt === "string" && prompt.length) result.prompt = prompt;
  const promptsRaw = map.get("aitc_prompts");
  if (typeof promptsRaw === "string" && promptsRaw) {
    try {
      const parsed = JSON.parse(promptsRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const prompts: Record<string, string> = {};
        for (const [name, value] of Object.entries(parsed)) if (typeof value === "string") prompts[name] = value;
        result.prompts = prompts;
      }
    } catch { /* ignore malformed legacy prompt map */ }
  }
  const temperatureRaw = map.get("aitc_temperature");
  if (typeof temperatureRaw === "string" && temperatureRaw.trim()) {
    const value = Number(temperatureRaw.trim());
    if (Number.isFinite(value) && value >= 0 && value <= 2) result.temperature = value;
  }
  return result;
}

/** Original JSON keys, so field presence (not value equality) decides whether the user set a field. */
async function readRawJson(context: PluginContext): Promise<{present: Set<string>; values: Record<string, unknown>} | undefined> {
  let file: string;
  try { file = context.files.dataPath("config.json"); } catch { return undefined; }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return {present: new Set(Object.keys(parsed)), values: parsed as Record<string, unknown>};
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error; // corrupt JSON is retryable, never treated as “no config”
  }
}

/** Removes only the legacy secret key; other rows, values and updated_at are preserved. */
async function eraseLegacyKey(context: PluginContext): Promise<void> {
  await context.storage.sqlite("aitc_config.db", {mustExist: true}).transaction(connection => {
    connection.prepare("DELETE FROM config WHERE key = ?").run("aitc_api_key");
  });
}

/**
 * Legacy migration state machine.
 * - `sqliteMigrated` guards the non-secret SQLite fields (once, snapshot-based).
 * - `providerMigrated` guards the central import and the SQLite secret erase.
 * The old `aiMigrated` flag never skips an unprocessed SQLite database.
 */
async function migrateLegacy(context: PluginContext): Promise<void> {
  // Completion is checked first so a finished migration never touches the legacy DB again;
  // a later corrupt/blocked DB cannot fail activation after the one-time migration.
  const initial = await store(context).read();
  if (initial.sqliteMigrated && initial.providerMigrated) return;
  const legacy = await readLegacyConfig(context);
  const raw = await readRawJson(context);
  const present = raw?.present ?? new Set<string>();
  const legacyKey = (legacy?.apiKey ?? "").trim();
  const initialPrompt = initial.prompt;
  const initialTemperature = initial.temperature;

  // 1. Non-secret fields. Concurrent writers win: a field changed since our snapshot is preserved,
  // and the JSON key presence captured before any write still decides the original priority.
  await store(context).update(value => {
    if (value.sqliteMigrated) return value;
    const patch: Partial<Config> = {};
    if (legacy) {
      if (!present.has("prompt") && value.prompt === initialPrompt && legacy.prompt) patch.prompt = legacy.prompt;
      if (legacy.prompts && Object.keys(legacy.prompts).length) patch.prompts = {...legacy.prompts, ...value.prompts};
      if (!present.has("temperature") && value.temperature === initialTemperature && legacy.temperature !== undefined) patch.temperature = legacy.temperature;
    }
    return {...value, ...patch, sqliteMigrated: true};
  });

  // 2. Provider migration: import into central ai, erase the SQLite secret, then mark done.
  const current = await store(context).read();
  if (current.providerMigrated) return;
  const jsonKey = typeof raw?.values.apiKey === "string" ? String(raw.values.apiKey).trim() : "";
  const jsonSource = jsonKey ? {key: jsonKey, url: current.apiUrl || DEFAULT_API_URL, model: current.model || DEFAULT_MODEL} : undefined;
  const legacySource = legacyKey ? {key: legacyKey, url: legacy?.apiUrl || DEFAULT_API_URL, model: legacy?.model || DEFAULT_MODEL} : undefined;
  if (!jsonSource && !legacySource) { await store(context).update(value => value.providerMigrated ? value : ({...value, providerMigrated: true})); return; }
  if (!context.services.available("ai", "import_provider")) return; // retry once ai is installed
  const importProvider = async (source: {key: string; url: string; model: string}, tag: string, select: string[]): Promise<void> => {
    const url = migrateBase(source.url);
    const model = source.model.trim() || DEFAULT_MODEL;
    await context.services.call("ai", "import_provider", {tag, url, key: source.key,
      type: "openai-compatible", models: {chat: model}, select}, context.signal);
  };
  try {
    if (jsonSource) await importProvider(jsonSource, "aitc", ["chat"]);
    // A legacy-only DB is the primary provider; a differing legacy provider is preserved
    // as its own central config instead of being silently dropped.
    if (legacySource && !jsonSource) await importProvider(legacySource, "aitc", ["chat"]);
    else if (legacySource && jsonSource && !sameProvider(jsonSource, legacySource)) await importProvider(legacySource, "aitc-legacy", []);
  } catch (error) {
    if (context.signal.aborted) throw error;
    return; // keep the secret for a later retry
  }
  if (legacyKey) {
    try { await eraseLegacyKey(context); }
    catch (error) { if (context.signal.aborted) throw error; return; }
  }
  await store(context).update(value => ({...value, apiKey: "", apiUrl: "", model: "", providerMigrated: true}));
}

function sameProvider(a: {key: string; url: string; model: string}, b: {key: string; url: string; model: string}): boolean {
  try { return a.key === b.key && (a.model.trim() || DEFAULT_MODEL) === (b.model.trim() || DEFAULT_MODEL) && migrateBase(a.url) === migrateBase(b.url); }
  catch { return false; }
}

function validateConfig(current: Config, patch: Record<string, unknown>): Config {
  const next: Config = {...current, prompts: {...current.prompts}};
  if (patch.apiKey !== undefined) {
    if (typeof patch.apiKey !== "string" || patch.apiKey.length > 4096) throw new Error("Invalid key");
    next.apiKey = patch.apiKey.trim();
  }
  if (patch.apiUrl !== undefined) {
    if (typeof patch.apiUrl !== "string" || patch.apiUrl.length > 2048) throw new Error("Invalid URL");
    endpoint(patch.apiUrl);
    next.apiUrl = patch.apiUrl.replace(/\/+$/, "");
  }
  if (patch.model !== undefined) {
    if (typeof patch.model !== "string" || !patch.model.trim() || patch.model.length > 200) throw new Error("Invalid model");
    next.model = patch.model.trim();
  }
  if (patch.prompt !== undefined) {
    if (typeof patch.prompt !== "string" || !patch.prompt.trim() || patch.prompt.length > 20_000) throw new Error("Invalid prompt");
    next.prompt = patch.prompt;
  }
  if (patch.temperature !== undefined) {
    if (typeof patch.temperature !== "number" || !Number.isFinite(patch.temperature) || patch.temperature < 0 || patch.temperature > 2) throw new Error("Invalid temperature");
    next.temperature = patch.temperature;
  }
  if (patch.prompts !== undefined) {
    if (!patch.prompts || typeof patch.prompts !== "object" || Array.isArray(patch.prompts)) throw new Error("Invalid prompts");
    const prompts: Record<string, string> = {};
    for (const [name, value] of Object.entries(patch.prompts)) {
      if (!/^[a-z0-9_-]{1,32}$/.test(name) || RESERVED.has(name) || typeof value !== "string" || !value.trim() || value.length > 20_000) throw new Error("Invalid prompts");
      prompts[name] = value;
    }
    next.prompts = prompts;
  }
  return next;
}

export default function createAitc() {
  const edit = (context: PluginContext, invocation: CommandInvocation, text: string, html = true) =>
    context.telegram.edit(invocation.message, text, html ? {parseMode: "html", linkPreview: false} : {linkPreview: false});
  const sendPaged = async (context: PluginContext, invocation: CommandInvocation, html: string): Promise<void> => {
    const pages = await ui.renderRichText(html, ui.PAGE_LABEL_RESERVE);
    const usable = pages.length ? pages : [html];
    await context.telegram.edit(invocation.message, usable[0], {parseMode: "html", linkPreview: false});
    for (let index = 1; index < usable.length; index++) {
      await context.telegram.reply(invocation.message, `${ui.pageLabel(index, usable.length)}\n${usable[index]}`, {parseMode: "html", linkPreview: false});
    }
  };
  const guard = (run: (invocation: CommandInvocation, context: PluginContext) => Promise<void>) =>
    async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
      try { await run(invocation, context); }
      catch {
        if (context.signal.aborted) return;
        context.log.error("aitc_failed");
        await edit(context, invocation, "AITC 调用失败，请检查配置和网络", false);
      }
    };
  const setString = (field: "prompt", missing: string, success: string) => async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const value = stripTokens(invocation.message.text ?? "", 2);
    if (!value.trim()) { await edit(context, invocation, missing, false); return; }
    await store(context).update(current => validateConfig(current, {[field]: value}));
    await edit(context, invocation, success, false);
  };
  const setTemperature = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const raw = stripTokens(invocation.message.text ?? "", 2).trim();
    if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) { await edit(context, invocation, "无效的温度值，请输入数字", false); return; }
    const value = Number(raw);
    if (value < 0 || value > 2) { await edit(context, invocation, "温度范围需在 0-2 之间", false); return; }
    await store(context).update(current => validateConfig(current, {temperature: value}));
    await edit(context, invocation, "温度已更新", false);
  };
  const setPreset = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const subcommandValue = stripTokens(invocation.message.text ?? "", 2);
    const aliasMatch = /^\S+/.exec(subcommandValue.trimStart());
    const aliasToken = aliasMatch?.[0] ?? "";
    const value = subcommandValue.trimStart().slice(aliasToken.length).trim();
    const name = aliasToken.toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(name) || RESERVED.has(name) || !value) { await edit(context, invocation, "Prompt 预设需要有效名称和内容", false); return; }
    await store(context).update(current => validateConfig(current, {prompts: {...current.prompts, [name]: value}}));
    await edit(context, invocation, `Prompt「${escape(aliasToken)}」已保存`);
  };
  const info = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    await migrateLegacy(context);
    const config = await store(context).read();
    const names = Object.keys(config.prompts).sort();
    let selection = "请先安装并配置 ai 插件";
    if (context.services.available("ai", "selection")) {
      const selected = await context.services.call<{chat?: {tag?: string; model?: string}}>("ai", "selection", null, context.signal);
      selection = selected.chat?.tag && selected.chat.model ? `${selected.chat.tag} / ${selected.chat.model}` : "请在 ai 插件中设置聊天模型";
    }
    await sendPaged(context, invocation, `<b>AITC 配置</b>\nAI：<code>${escape(selection)}</code>\n温度：<code>${config.temperature}</code>\n默认 Prompt：${escape(config.prompt)}\n预设：${names.length ? names.map(name => `<code>${escape(name)}</code>`).join(" · ") : "未保存"}`);
  };
  const centralConfig = async (invocation: CommandInvocation, context: PluginContext): Promise<void> =>
    edit(context, invocation, `供应商与模型由 ai 插件统一管理，请使用 ${invocation.prefix}ai config 和 ${invocation.prefix}ai model chat。`, false);
  const aitc: CommandDefinition = {
    description: "AI 转写与 Prompt 预设管理",
    helpArgs: ["help", "h"],
    args: "[预设] [文本]",
    arguments: [{name: "预设", description: "已保存的 Prompt 预设名；省略时使用默认 Prompt"}, {name: "文本", description: "要转写的文本；也可回复一条文字消息"}],
    examples: [{args: "文本"}, {args: "预设 文本"}, {args: "info"}],
    help: [
      {heading: "说明：", body: "使用 ai 插件当前聊天供应商与模型，温度默认 0.2，默认 Prompt 转写为英文。检索 Prompt 预设名后跟文本即使用该预设，否则使用默认 Prompt。"},
      {heading: "AI 配置：", body: "先安装 ai 插件，再用 <code>{prefix}ai config</code> 与 <code>{prefix}ai model chat</code> 统一管理供应商、密钥和模型。"},
    ],
    subcommandsCaseSensitive: false,
    subcommands: {
      key: {aliases: ["apikey", "_set_key"], description: "查看统一 AI 配置方式", args: "", handle: guard(centralConfig)},
      url: {aliases: ["api", "_set_url", "_set_api"], description: "查看统一 AI 配置方式", args: "", handle: guard(centralConfig)},
      model: {aliases: ["_set_model"], description: "查看统一 AI 配置方式", args: "", handle: guard(centralConfig)},
      prompt: {aliases: ["_set_prompt"], description: "设置默认 Prompt", args: "Prompt 文本", examples: [{args: "prompt 翻译为英文"}], handle: guard(setString("prompt", "请提供 Prompt 文本", "默认 Prompt 已更新"))},
      temp: {aliases: ["temperature", "_set_temperature"], description: "设置模型温度", args: "0-2", examples: [{args: "temp 0.2"}], handle: guard(setTemperature)},
      spn: {description: "保存或更新 Prompt 预设", args: "名称 Prompt", arguments: [{name: "名称", required: true, description: "字母、数字、下划线或连字符，1-32 位"}, {name: "Prompt", required: true, description: "预设内容"}], examples: [{args: "spn en Translate to English"}], handle: guard(setPreset)},
      info: {aliases: ["_info"], description: "查看当前配置", args: "", examples: [{args: "info"}], handle: guard(info)},
    },
    async handle(invocation, context) {
      const text = invocation.message.text ?? "";
      const rest = stripTokens(text, 1);
      const firstToken = (/^\S+/.exec(rest.trimStart())?.[0] ?? "").toLowerCase();
      if (firstToken === "help" || firstToken === "h" || (!rest.trim() && invocation.message.replyToId === undefined)) {
        await edit(context, invocation, renderCommandHelp("aitc", aitc, {prefix: invocation.prefix}), true); return;
      }
      try {
        if (firstToken.startsWith("_")) { await edit(context, invocation, "未知配置命令", false); return; }
        const config = await store(context).read();
        let prompt = config.prompt;
        let input = rest;
        if (config.prompts[firstToken]) {
          prompt = config.prompts[firstToken]!;
          input = rest.trimStart().slice((/^\S+/.exec(rest.trimStart())?.[0] ?? "").length);
        }
        if (!input.trim() && invocation.message.replyToId !== undefined) input = ((await context.telegram.getReply(invocation.message))?.text ?? "").trim();
        if (!input.trim()) { await edit(context, invocation, "请提供文本或回复一条文字消息", false); return; }
        if (input.length > 50_000) { await edit(context, invocation, "输入文本过长", false); return; }
        await migrateLegacy(context);
        if (!context.services.available("ai", "chat")) { await edit(context, invocation, "请先安装并配置 ai 插件", false); return; }
        await edit(context, invocation, "正在请求…", false);
        const content = await context.services.call<string>("ai", "chat", {text: input, systemPrompt: prompt, temperature: config.temperature}, context.signal);
        if (typeof content !== "string" || !content.trim()) throw new Error("Empty output");
        await sendPaged(context, invocation, ui.text(sanitizePlainText(content)));
      } catch {
        if (context.signal.aborted) return;
        context.log.error("aitc_failed");
        await edit(context, invocation, "AITC 调用失败，请检查配置和网络", false);
      }
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "aitc", description: "使用统一 AI 服务和自定义 Prompt 转写文本",
    renderHelp: prefix => renderCommandHelp("aitc", aitc, {prefix, title: "自定义 Prompt 的 AI 转写插件："}),
    commands: {aitc},
    settings: context => ({
      id: "aitc", title: "AITC", description: "Prompt 与转写参数", category: "插件配置", icon: "✨",
      getSchema: () => [
        {key: "temperature", label: "温度", type: "number", min: 0, max: 2},
        {key: "prompt", label: "默认 Prompt", type: "textarea", required: true},
        {key: "prompts", label: "Prompt 预设", type: "prompt-map"},
      ],
      async getValues() { const value = await store(context).read(); return {temperature: value.temperature, prompt: value.prompt, prompts: value.prompts}; },
      setValues: async patch => { await store(context).update(current => validateConfig(current, patch)); },
    }),
    setup: migrateLegacy,
  });
}
