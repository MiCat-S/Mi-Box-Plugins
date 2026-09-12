import {readFile, rename, writeFile} from "node:fs/promises";
import {
  STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp,
  type CommandDefinition, type CommandInvocation, type PluginContext, type PluginDefinition,
} from "telebox/sdk";

const DEFAULT_MAX_DURATION = 15 * 60;
const DEFAULT_MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_COOKIE_LENGTH = 512 * 1024;
const qualityValues = ["", ...Array.from({length: 11}, (_, index) => String(index)), "64k", "96k", "128k", "160k", "192k", "256k", "320k"];

interface LegacyAi {key: string; url: string; model: string}
interface SongMetadata {title: string; artist: string; album?: string}
interface MusicDependencies {scrubLegacyKey?: (file: string, raw: Record<string, unknown>) => Promise<void>}
interface State extends Record<string, unknown> {
  schemaVersion: 1;
  cookie: string;
  proxy: string;
  quality: string;
  aiEnabled: boolean;
  maxDurationSeconds: number;
  maxUploadBytes: number;
  legacyMigrated: boolean;
  aiMigrated: boolean;
  legacyAi?: LegacyAi;
  importedAiTag?: string;
}

const defaults = (): State => ({
  schemaVersion: 1, cookie: "", proxy: "", quality: "", aiEnabled: true,
  maxDurationSeconds: DEFAULT_MAX_DURATION, maxUploadBytes: DEFAULT_MAX_UPLOAD,
  legacyMigrated: false, aiMigrated: false,
});
const store = (context: PluginContext) => context.storage.json<State>("config.json", defaults());
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function quality(value: unknown): string | undefined {
  const input = String(value ?? "").trim().toLowerCase();
  if (["auto", "best", "none", "clear"].includes(input)) return "";
  if (/^(?:[0-9]|10)$/.test(input)) return input;
  const match = /^(64|96|128|160|192|256|320)\s*(?:k|kb|kbps)?$/.exec(input);
  return match ? `${match[1]}k` : undefined;
}

function proxy(value: unknown): string | undefined {
  const input = String(value ?? "").trim();
  if (["", "none", "clear"].includes(input.toLowerCase())) return "";
  if (input.length > 2048) return undefined;
  try {
    const parsed = new URL(input);
    return ["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) && parsed.hostname ? input : undefined;
  } catch { return undefined; }
}

function normalized(source: State): State {
  const base = defaults();
  return {...source, schemaVersion: 1,
    cookie: typeof source.cookie === "string" && source.cookie.length <= MAX_COOKIE_LENGTH ? source.cookie : "",
    proxy: proxy(source.proxy) ?? "", quality: quality(source.quality) ?? "",
    aiEnabled: typeof source.aiEnabled === "boolean" ? source.aiEnabled : base.aiEnabled,
    maxDurationSeconds: Number.isSafeInteger(source.maxDurationSeconds) && source.maxDurationSeconds >= 60 && source.maxDurationSeconds <= 1800
      ? source.maxDurationSeconds : base.maxDurationSeconds,
    maxUploadBytes: Number.isSafeInteger(source.maxUploadBytes) && source.maxUploadBytes >= 1024 * 1024 && source.maxUploadBytes <= DEFAULT_MAX_UPLOAD
      ? source.maxUploadBytes : base.maxUploadBytes,
    legacyMigrated: source.legacyMigrated === true, aiMigrated: source.aiMigrated === true};
}

function legacyValue(source: Record<string, unknown>, key: string): string {
  for (const candidate of [source, record(source.settings), record(source.apiKeys), record(source.cookies)]) {
    if (typeof candidate[key] === "string") return String(candidate[key]);
  }
  if (key === "music_gemini_api_key" && typeof record(source.settings).apikey === "string") return String(record(source.settings).apikey);
  return "";
}

async function legacyFile(context: PluginContext): Promise<{path: string; raw: Record<string, unknown>} | undefined> {
  const file = context.files.dataPath("music_config.json");
  try { return {path: file, raw: record(JSON.parse(await readFile(file, "utf8")))}; }
  catch { return undefined; }
}

async function scrubLegacyKey(file: string, raw: Record<string, unknown>): Promise<void> {
  const key = "music_gemini_api_key";
  if (Object.hasOwn(raw, key)) raw[key] = "";
  for (const group of ["settings", "apiKeys"] as const) {
    const values = record(raw[group]);
    if (Object.hasOwn(values, key)) values[key] = "";
    if (group === "settings" && Object.hasOwn(values, "apikey")) values.apikey = "";
    if (Object.keys(values).length) raw[group] = values;
  }
  const temporary = `${file}.v2-migration`;
  await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, {encoding: "utf8", mode: 0o600});
  await rename(temporary, file);
}

function geminiUrl(value: string): string {
  const fallback = "https://generativelanguage.googleapis.com/v1beta";
  if (!value.trim()) return fallback;
  try {
    const url = new URL(value.trim());
    if (url.hostname === "generativelanguage.googleapis.com" && ["", "/"].includes(url.pathname)) {
      url.pathname = "/v1beta";
      url.search = "";
      url.hash = "";
    }
    return url.toString().replace(/\/$/, "");
  } catch { return value.trim(); }
}

async function migrate(context: PluginContext, dependencies: MusicDependencies = {}): Promise<void> {
  let legacy = await legacyFile(context);
  let state = normalized(await store(context).read());
  if (!state.legacyMigrated) {
    state = await store(context).update(current => {
      const next = normalized(current);
      if (!legacy) return {...next, legacyMigrated: true, aiMigrated: true};
      const key = legacyValue(legacy.raw, "music_gemini_api_key").trim();
      const legacyProxy = proxy(legacyValue(legacy.raw, "music_ytdlp_proxy"));
      const legacyQuality = quality(legacyValue(legacy.raw, "music_audio_quality"));
      return {...next,
        cookie: next.cookie || legacyValue(legacy.raw, "music_ytdlp_cookie"),
        proxy: next.proxy || legacyProxy || "", quality: next.quality || legacyQuality || "",
        legacyMigrated: true, aiMigrated: !key,
        ...(key ? {legacyAi: {key,
          url: geminiUrl(legacyValue(legacy.raw, "music_gemini_base_url")),
          model: legacyValue(legacy.raw, "music_gemini_model").trim() || "gemini-2.0-flash"}} : {}),
      };
    });
  }
  if (state.aiMigrated || !state.legacyAi?.key || !context.services.available("ai", "import_provider")) return;
  try {
    const result = await context.services.call<{tag?: unknown}>("ai", "import_provider", {
      tag: "music", url: state.legacyAi.url, key: state.legacyAi.key, type: "gemini",
      stream: false, responses: false, models: {chat: state.legacyAi.model}, select: ["chat"],
    }, context.signal);
    legacy ??= await legacyFile(context);
    if (legacy) await (dependencies.scrubLegacyKey ?? scrubLegacyKey)(legacy.path, legacy.raw);
    await store(context).update(current => {
      const {legacyAi: _legacyAi, ...rest} = normalized(current);
      return {...rest, aiMigrated: true,
        ...(typeof result.tag === "string" ? {importedAiTag: result.tag} : {})} as State;
    });
  } catch {
    context.signal.throwIfAborted();
    context.log.error("music_ai_migration_failed");
  }
}

function manualMetadata(query: string): SongMetadata | undefined {
  const parts = query.split(/\s+[-–—]\s+/).map(value => value.trim()).filter(Boolean);
  return parts.length >= 2 ? {artist: parts[0]!, title: parts[1]!, ...(parts[2] ? {album: parts[2]} : {})} : undefined;
}

function aiMetadata(text: unknown): SongMetadata | undefined {
  if (typeof text !== "string") return undefined;
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(歌曲名|歌手|专辑)\s*[:：]\s*(.*?)\s*$/.exec(line);
    if (match && match[2] && match[2] !== "未知") fields[match[1]!] = match[2];
  }
  return fields.歌曲名 && fields.歌手 ? {title: fields.歌曲名.slice(0, 200), artist: fields.歌手.slice(0, 200), ...(fields.专辑 ? {album: fields.专辑.slice(0, 200)} : {})} : undefined;
}

async function recognize(context: PluginContext, query: string, enabled: boolean, signal: AbortSignal): Promise<SongMetadata | undefined> {
  const manual = manualMetadata(query);
  if (manual || !enabled || !context.services.available("ai", "chat") || query.includes("://")) return manual;
  try {
    return aiMetadata(await context.services.call("ai", "chat", {
      text: query,
      systemPrompt: "识别歌曲信息。仅按三行返回：歌曲名: 名称；歌手: 姓名；专辑: 名称或未知。不要添加其他内容。",
      temperature: 0.2, maxOutputTokens: 256,
    }, signal));
  } catch { signal.throwIfAborted(); return undefined; }
}

async function removeReceipt(context: PluginContext, invocation: CommandInvocation): Promise<void> {
  const raw = invocation.message.raw as {delete?: (options: {revoke: boolean}) => Promise<unknown>} | undefined;
  if (typeof raw?.delete !== "function") return;
  try {
    await context.telegram.withClient(async (_client, signal) => {
      signal.throwIfAborted();
      await raw.delete!({revoke: true});
    });
  } catch { if (!context.signal.aborted) context.log.info("music_receipt_cleanup_failed"); }
}

export default function createMusic(dependencies: MusicDependencies = {}): PluginDefinition {
  const showConfig = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    await migrate(context, dependencies);
    const state = normalized(await store(context).read());
    await context.telegram.edit(invocation.message,
      `<b>Music 配置</b>\nCookie：${state.cookie ? "已设置" : "未设置"}\n代理：${state.proxy ? "已设置" : "未设置"}\n音质：<code>${state.quality || "自动"}</code>\nAI 识别：${state.aiEnabled && context.services.available("ai", "chat") ? "可用" : state.aiEnabled ? "等待 ai.chat" : "已关闭"}\n时长上限：${state.maxDurationSeconds} 秒\n上传上限：${Math.floor(state.maxUploadBytes / 1048576)} MB`,
      {parseMode: "html", linkPreview: false});
  };
  const setSecret = (key: "cookie" | "proxy") => async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const raw = invocation.args.join(" ").trim();
    if (!invocation.message.saved) { await context.telegram.edit(invocation.message, "Cookie 或含凭据的代理只能在收藏夹中配置"); return; }
    const value = key === "cookie" ? (["none", "clear"].includes(raw.toLowerCase()) ? "" : raw) : proxy(raw);
    if (value === undefined || key === "cookie" && value.length > MAX_COOKIE_LENGTH) { await context.telegram.edit(invocation.message, "配置值无效或过长"); return; }
    await store(context).update(current => ({...normalized(current), [key]: value}));
    await context.telegram.edit(invocation.message, `${key === "cookie" ? "Cookie" : "代理"}已${value ? "设置" : "清除"}`);
  };
  const setQuality = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const value = quality(invocation.args[0]);
    if (value === undefined) { await context.telegram.edit(invocation.message, "音质须为 0–10、64k/96k/128k/160k/192k/256k/320k 或 auto"); return; }
    await store(context).update(current => ({...normalized(current), quality: value}));
    await context.telegram.edit(invocation.message, `音质已设置为 ${value || "自动"}`);
  };
  const aiGuide = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    await context.telegram.edit(invocation.message, `AI 供应商、密钥和模型由 ai 插件统一管理，请使用 ${invocation.prefix}ai config 与 ${invocation.prefix}ai model chat。`);
  };
  let musicCommand!: CommandDefinition;
  const setCommand: CommandDefinition = {
    description: "设置下载配置", args: "cookie|proxy|quality ...", subcommandsCaseSensitive: false,
    subcommands: {
      cookie: {description: "设置 YouTube Cookie（仅收藏夹）", args: "值|clear", handle: setSecret("cookie")},
      proxy: {description: "设置下载代理（仅收藏夹）", args: "URL|clear", handle: setSecret("proxy")},
      quality: {description: "设置 MP3 音质", args: "0-10|64k-320k|auto", handle: setQuality},
      api_key: {description: "查看统一 AI 密钥配置方式", args: "", handle: aiGuide},
      base_url: {aliases: ["baseurl"], description: "查看统一 AI 地址配置方式", args: "", handle: aiGuide},
      model: {description: "查看统一 AI 模型配置方式", args: "", handle: aiGuide},
    },
    async handle(invocation, context) {
      await context.telegram.edit(invocation.message, renderCommandHelp("music", musicCommand, {prefix: invocation.prefix, path: ["set"]}), {parseMode: "html"});
    },
  };
  musicCommand = {
    description: "搜索或通过 YouTube 链接下载单曲 MP3",
    args: "关键词或 YouTube URL", helpOnEmpty: true, helpArgs: ["help", "h"], ignoreEdited: true,
    arguments: [{name: "关键词或 YouTube URL", required: true, description: "最多 300 字符；只处理单曲，拒绝播放列表和直播"}],
    examples: [{args: "周杰伦 晴天"}, {args: "周杰伦 - 晴天"}, {args: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}],
    subcommandsCaseSensitive: false,
    subcommands: {
      config: {description: "查看当前下载配置", args: "", handle: showConfig},
      set: setCommand,
      clear: {description: "说明临时文件清理策略", args: "", async handle(invocation, context) { await context.telegram.edit(invocation.message, "临时文件由插件生命周期自动清理，当前没有保留文件。"); }},
    },
    help: [
      {heading: "下载范围：", body: "只下载单曲 MP3；最长 15 分钟、默认最大 50 MB。播放列表、直播、通用视频和格式选择不在当前版本范围。"},
      {heading: "运行条件：", body: "宿主需预先安装 yt-dlp 与 FFmpeg。插件不会在运行时下载、更新或执行远端二进制。"},
      {heading: "AI：", body: "安装并配置 ai 插件后，可通过公开的 ai.chat 服务辅助识别关键词；未安装时使用 yt-dlp 元数据。"},
    ],
    async handle(invocation, context) {
      const query = invocation.args.join(" ").trim();
      if (!query) { await context.telegram.edit(invocation.message, renderCommandHelp("music", musicCommand, {prefix: invocation.prefix}), {parseMode: "html"}); return; }
      if (!context.services.available("yt-dlp", "download_mp3")) {
        await context.telegram.edit(invocation.message, "music 需要 yt-dlp 插件提供下载服务；请先安装并启用 yt-dlp");
        return;
      }
      await migrate(context, dependencies);
      const state = normalized(await store(context).read());
      try {
        const metadata = await recognize(context, query, state.aiEnabled, context.signal);
        await context.telegram.edit(invocation.message, metadata ? `已识别：${metadata.artist} - ${metadata.title}\n正在下载…` : "正在查找并下载音乐…");
        const search = metadata && !query.includes("://") ? `${metadata.artist} ${metadata.title} lyrics` : query;
        await context.services.call("yt-dlp", "download_mp3", {
          query: search,
          message: invocation.message,
          ...(metadata ? {preferred: metadata} : {}),
          options: {cookie: state.cookie, proxy: state.proxy, quality: state.quality,
            maxDurationSeconds: state.maxDurationSeconds, maxUploadBytes: state.maxUploadBytes},
        }, context.signal);
        await removeReceipt(context, invocation);
      } catch (error) {
        if (context.signal.aborted) return;
        context.log.error("music_download_failed", {kind: error instanceof Error ? error.name : "unknown"});
        const missing = error instanceof Error && error.message === "DEPENDENCY_MISSING";
        await context.telegram.edit(invocation.message, missing
          ? "缺少 yt-dlp 或 FFmpeg；请由系统管理员预先安装后重试"
          : "音乐下载失败；请检查链接、时长、文件大小、Cookie、代理和网络后重试");
      }
    },
  };
  const settings: NonNullable<PluginDefinition["settings"]> = context => ({
    id: "music", title: "YouTube Music", description: "下载限制、Cookie、代理与音质", category: "插件配置", icon: "🎵",
    getSchema: () => [
      {key: "cookie", label: "YouTube Cookie", type: "password", secret: true, max: MAX_COOKIE_LENGTH},
      {key: "proxy", label: "下载代理", type: "password", secret: true, max: 2048},
      {key: "quality", label: "MP3 音质", type: "select", options: qualityValues.map(value => ({value, label: value || "自动"}))},
      {key: "aiEnabled", label: "使用 ai.chat 识别", type: "boolean"},
      {key: "maxDurationSeconds", label: "最长时长（秒）", type: "number", min: 60, max: 1800},
      {key: "maxUploadBytes", label: "最大上传字节数", type: "number", min: 1024 * 1024, max: DEFAULT_MAX_UPLOAD},
    ],
    async getValues() { const state = normalized(await store(context).read()); return {cookie: state.cookie, proxy: state.proxy, quality: state.quality,
      aiEnabled: state.aiEnabled, maxDurationSeconds: state.maxDurationSeconds, maxUploadBytes: state.maxUploadBytes}; },
    async setValues(patch, signal) {
      if (patch.cookie !== undefined && (typeof patch.cookie !== "string" || patch.cookie.length > MAX_COOKIE_LENGTH)) throw new Error("Invalid cookie");
      if (patch.proxy !== undefined && (typeof patch.proxy !== "string" || proxy(patch.proxy) === undefined)) throw new Error("Invalid proxy");
      if (patch.quality !== undefined && (typeof patch.quality !== "string" || quality(patch.quality) === undefined)) throw new Error("Invalid quality");
      if (patch.aiEnabled !== undefined && typeof patch.aiEnabled !== "boolean") throw new Error("Invalid AI setting");
      for (const [key, minimum, maximum] of [["maxDurationSeconds", 60, 1800], ["maxUploadBytes", 1024 * 1024, DEFAULT_MAX_UPLOAD]] as const) {
        const value = patch[key]; if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)) throw new Error("Invalid limit");
      }
      await store(context).update(current => normalized({...current, ...patch,
        ...(patch.proxy !== undefined ? {proxy: proxy(patch.proxy)!} : {}),
        ...(patch.quality !== undefined ? {quality: quality(patch.quality)!} : {})} as State), signal);
    },
  });
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "music", description: "搜索并下载 YouTube 单曲 MP3",
    renderHelp: prefix => renderCommandHelp("music", musicCommand, {prefix, title: "🎵 YouTube 音乐下载器"}),
    commands: {music: musicCommand}, settings, setup: context => migrate(context, dependencies),
  });
}
