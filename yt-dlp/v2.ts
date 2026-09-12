import {
  STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, requireSdkFeatures,
  type CommandDefinition, type MessageEnvelope, type PluginContext, type PluginDefinition,
} from "telebox/sdk";
import {
  downloadAndSend, type DownloadDependencies, type DownloadOptions, type DownloadResult, type SongMetadata,
} from "./v2/download";

const MAX_PROCESS_OUTPUT = 512 * 1024;
requireSdkFeatures("legacySqlite");
const DEFAULT_MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_COOKIE_LENGTH = 512 * 1024;
const QUALITY = /^(?:|[0-9]|10|64k|96k|128k|160k|192k|256k|320k)$/;

interface State extends Record<string, unknown> {
  schemaVersion: 1;
  aiEnabled: boolean;
  maxDurationSeconds: number;
  maxUploadBytes: number;
  legacyAiMigrated: boolean;
  importedAiTag?: string;
}
interface DownloadServiceRequest {query: string; message: MessageEnvelope; preferred?: SongMetadata; options: DownloadOptions}

const LEGACY_DB = "ytdlp_gemini_config.db";
const LEGACY_AI_KEY = "ytdlp_gemini_api_key";
const defaults = (): State => ({schemaVersion: 1, aiEnabled: true, maxDurationSeconds: 15 * 60,
  maxUploadBytes: DEFAULT_MAX_UPLOAD, legacyAiMigrated: false});
const store = (context: PluginContext) => context.storage.json<State>("config.json", defaults());
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function normalized(source: State): State {
  const base = defaults();
  return {...source, schemaVersion: 1, aiEnabled: typeof source.aiEnabled === "boolean" ? source.aiEnabled : true,
    maxDurationSeconds: Number.isSafeInteger(source.maxDurationSeconds) && source.maxDurationSeconds >= 60 && source.maxDurationSeconds <= 1800 ? source.maxDurationSeconds : base.maxDurationSeconds,
    maxUploadBytes: Number.isSafeInteger(source.maxUploadBytes) && source.maxUploadBytes >= 1024 * 1024 && source.maxUploadBytes <= DEFAULT_MAX_UPLOAD ? source.maxUploadBytes : base.maxUploadBytes,
    legacyAiMigrated: source.legacyAiMigrated === true};
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

function missingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function migrateLegacyAi(context: PluginContext): Promise<void> {
  if (normalized(await store(context).read()).legacyAiMigrated) return;
  const legacy = context.storage.legacySqlite(LEGACY_DB);
  let values: Record<string, string>;
  try {
    const preflight = await legacy.preflight({config: ["key", "value"]}, context.signal);
    if (!preflight.compatible) throw new Error("INVALID_LEGACY_DB");
    values = await legacy.read(db => Object.fromEntries(
      (db.prepare("SELECT key, value FROM config WHERE key IN (?, ?, ?)")
        .all(LEGACY_AI_KEY, "ytdlp_gemini_base_url", "ytdlp_gemini_model") as {key: string; value: string}[])
        .map(row => [row.key, row.value]),
    ), context.signal);
  } catch (error) {
    if (!missingFile(error)) throw error;
    await store(context).update(current => ({...normalized(current), legacyAiMigrated: true}), context.signal);
    return;
  }
  const key = String(values[LEGACY_AI_KEY] ?? "").trim();
  if (!key) {
    await store(context).update(current => ({...normalized(current), legacyAiMigrated: true}), context.signal);
    return;
  }
  if (!context.services.available("ai", "import_provider")) return;
  try {
    const result = await context.services.call<{tag?: unknown}>("ai", "import_provider", {
      tag: "yt-dlp", type: "gemini", key,
      url: geminiUrl(String(values.ytdlp_gemini_base_url ?? "")),
      stream: false, responses: false,
      models: {chat: String(values.ytdlp_gemini_model ?? "").trim() || "gemini-2.0-flash"}, select: ["chat"],
    }, context.signal);
    await legacy.transaction(db => {
      db.prepare("UPDATE config SET value = '' WHERE key = ?").run(LEGACY_AI_KEY);
    }, context.signal);
    await store(context).update(current => ({...normalized(current), legacyAiMigrated: true,
      ...(typeof result.tag === "string" ? {importedAiTag: result.tag} : {})}), context.signal);
  } catch {
    context.signal.throwIfAborted();
    context.log.error("yt_dlp_ai_migration_failed");
  }
}

function manualMetadata(query: string): SongMetadata | undefined {
  if (query.includes("://")) return undefined;
  const match = /^(.+?)\s*[-–—|·]\s*(.+)$/.exec(query);
  return match ? {title: match[1]!.trim(), artist: match[2]!.trim()} : undefined;
}

function aiMetadata(value: unknown): SongMetadata | undefined {
  if (typeof value !== "string") return undefined;
  const fields: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const match = /^\s*(歌曲名|歌手|专辑)\s*[:：]\s*(.*?)\s*$/.exec(line);
    if (match && match[2] && match[2] !== "未知") fields[match[1]!] = match[2];
  }
  return fields.歌曲名 && fields.歌手 ? {title: fields.歌曲名.slice(0, 140), artist: fields.歌手.slice(0, 140), ...(fields.专辑 ? {album: fields.专辑.slice(0, 140)} : {})} : undefined;
}

async function recognize(context: PluginContext, query: string, enabled: boolean, signal: AbortSignal): Promise<SongMetadata | undefined> {
  const manual = manualMetadata(query);
  if (manual || !enabled || query.includes("://") || !context.services.available("ai", "chat")) return manual;
  try {
    return aiMetadata(await context.services.call("ai", "chat", {text: query,
      systemPrompt: "识别歌曲信息。仅按三行返回：歌曲名: 名称；歌手: 姓名；专辑: 名称或未知。不要添加其他内容。",
      temperature: 0.2, maxOutputTokens: 256}, signal));
  } catch { signal.throwIfAborted(); return undefined; }
}

function serviceRequest(input: unknown): DownloadServiceRequest {
  const value = record(input);
  const query = typeof value.query === "string" ? value.query.trim() : "";
  const rawMessage = record(value.message);
  const chatId = typeof rawMessage.chatId === "string" ? rawMessage.chatId : "";
  if (!query || query.length > 300 || /[\u0000-\u001f]/.test(query) || !Number.isSafeInteger(rawMessage.id) || !/^-?\d+$/.test(chatId) || !rawMessage.raw) {
    throw new Error("INVALID_SERVICE_INPUT");
  }
  const rawOptions = record(value.options);
  const cookie = typeof rawOptions.cookie === "string" ? rawOptions.cookie : "";
  const proxy = typeof rawOptions.proxy === "string" ? rawOptions.proxy : "";
  const quality = typeof rawOptions.quality === "string" ? rawOptions.quality.toLowerCase() : "";
  const maxDurationSeconds = Number(rawOptions.maxDurationSeconds);
  const maxUploadBytes = Number(rawOptions.maxUploadBytes);
  if (cookie.length > MAX_COOKIE_LENGTH || proxy.length > 2048 || !QUALITY.test(quality) ||
      !Number.isSafeInteger(maxDurationSeconds) || maxDurationSeconds < 60 || maxDurationSeconds > 1800 ||
      !Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1024 * 1024 || maxUploadBytes > DEFAULT_MAX_UPLOAD) {
    throw new Error("INVALID_SERVICE_INPUT");
  }
  const rawPreferred = value.preferred === undefined ? undefined : record(value.preferred);
  let preferred: SongMetadata | undefined;
  if (rawPreferred) {
    const title = typeof rawPreferred.title === "string" ? rawPreferred.title.trim() : "";
    const artist = typeof rawPreferred.artist === "string" ? rawPreferred.artist.trim() : "";
    const album = typeof rawPreferred.album === "string" ? rawPreferred.album.trim() : undefined;
    if (!title || !artist || title.length > 200 || artist.length > 200 || (album?.length ?? 0) > 200) throw new Error("INVALID_SERVICE_INPUT");
    preferred = {title, artist, ...(album ? {album} : {})};
  }
  return {query, message: value.message as MessageEnvelope, ...(preferred ? {preferred} : {}),
    options: {cookie, proxy, quality, maxDurationSeconds, maxUploadBytes}};
}

async function removeReceipt(context: PluginContext, message: MessageEnvelope, label: string): Promise<void> {
  const raw = message.raw as {delete?: (options: {revoke: boolean}) => Promise<unknown>} | undefined;
  if (typeof raw?.delete !== "function") return;
  try {
    await context.telegram.withClient(async (_client, signal) => {
      signal.throwIfAborted();
      await raw.delete!({revoke: true});
    });
  } catch { if (!context.signal.aborted) context.log.info(label); }
}

export default function createYtDlp(dependencies: DownloadDependencies = {}): PluginDefinition {
  const apiGuide = async (invocation: Parameters<CommandDefinition["handle"]>[0], context: PluginContext): Promise<void> => {
    await context.telegram.edit(invocation.message, `Gemini/API Key 已由 ai 插件统一管理，请使用 ${invocation.prefix}ai config 与 ${invocation.prefix}ai model chat。`);
  };
  const update = async (invocation: Parameters<CommandDefinition["handle"]>[0], context: PluginContext): Promise<void> => {
    await context.telegram.edit(invocation.message, "V2 不会下载或自更新可执行文件。请由系统管理员通过受信任的软件包渠道更新 yt-dlp，并在更新后重试。");
  };
  let ytCommand!: CommandDefinition;
  ytCommand = {
    description: "搜索并下载 YouTube 单曲 MP3", args: "关键词或 YouTube URL",
    helpOnEmpty: true, helpArgs: ["help", "h"], ignoreEdited: true,
    arguments: [{name: "关键词或 YouTube URL", required: true, description: "手动元数据可写为 歌名-歌手；最多 300 字符"}],
    examples: [{args: "稻香"}, {args: "晴天-周杰伦"}, {args: "https://youtu.be/dQw4w9WgXcQ"}],
    subcommandsCaseSensitive: false,
    subcommands: {
      apikey: {description: "查看统一 AI 密钥配置方式", args: "", handle: apiGuide},
      update: {description: "查看 yt-dlp 安全更新方式", args: "", handle: update},
    },
    help: [
      {heading: "当前范围：", body: "下载单曲 MP3 并发送封面与 Telegram 音频元数据；最长 15 分钟、默认最大 50 MB。播放列表、通用视频和格式选择当前不支持。"},
      {heading: "运行条件：", body: "宿主需预先安装 yt-dlp 与 FFmpeg。V2 不会下载 latest 可执行文件，也不会在运行时更新系统组件。"},
      {heading: "AI：", body: "可选调用 ai.chat 识别关键词；未安装或调用失败时使用 yt-dlp 返回的标题与上传者。"},
    ],
    async handle(invocation, context) {
      const query = invocation.args.join(" ").trim();
      if (!query) { await context.telegram.edit(invocation.message, renderCommandHelp("yt", ytCommand, {prefix: invocation.prefix}), {parseMode: "html"}); return; }
      await migrateLegacyAi(context);
      const state = normalized(await store(context).read());
      try {
        const metadata = await recognize(context, query, state.aiEnabled, context.signal);
        await context.telegram.edit(invocation.message, metadata ? `已识别：${metadata.title} - ${metadata.artist}\n正在下载…` : "正在搜索并下载音乐…");
        const search = metadata && !query.includes("://") ? `${metadata.artist} ${metadata.title}` : query;
        await downloadAndSend(context, invocation.message, search, {
          cookie: "", proxy: "", quality: "", maxDurationSeconds: state.maxDurationSeconds, maxUploadBytes: state.maxUploadBytes,
        }, metadata, context.signal, dependencies);
        await removeReceipt(context, invocation.message, "yt_dlp_receipt_cleanup_failed");
      } catch (error) {
        if (context.signal.aborted) return;
        context.log.error("yt_dlp_download_failed", {kind: error instanceof Error ? error.name : "unknown"});
        const missing = error instanceof Error && error.message === "DEPENDENCY_MISSING";
        await context.telegram.edit(invocation.message, missing
          ? "缺少 yt-dlp 或 FFmpeg；请由系统管理员预先安装后重试"
          : "下载失败；请检查关键词、链接、时长、文件大小和网络后重试");
      }
    },
  };
  const settings: NonNullable<PluginDefinition["settings"]> = context => ({
    id: "yt-dlp", title: "YouTube 单曲下载", description: "AI 开关与下载限制", category: "插件配置", icon: "🎵",
    getSchema: () => [
      {key: "aiEnabled", label: "使用 ai.chat 识别", type: "boolean"},
      {key: "maxDurationSeconds", label: "最长时长（秒）", type: "number", min: 60, max: 1800},
      {key: "maxUploadBytes", label: "最大上传字节数", type: "number", min: 1024 * 1024, max: DEFAULT_MAX_UPLOAD},
    ],
    async getValues() { const value = normalized(await store(context).read()); return {aiEnabled: value.aiEnabled, maxDurationSeconds: value.maxDurationSeconds, maxUploadBytes: value.maxUploadBytes}; },
    async setValues(patch, signal) {
      if (patch.aiEnabled !== undefined && typeof patch.aiEnabled !== "boolean") throw new Error("Invalid AI setting");
      for (const [key, minimum, maximum] of [["maxDurationSeconds", 60, 1800], ["maxUploadBytes", 1024 * 1024, DEFAULT_MAX_UPLOAD]] as const) {
        const value = patch[key]; if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)) throw new Error("Invalid limit");
      }
      await store(context).update(current => normalized({...current, ...patch} as State), signal);
    },
  });
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "yt-dlp", description: "搜索并下载 YouTube 单曲 MP3",
    legacyStorage: {sqlite: [LEGACY_DB]},
    resources: {processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 180_000, maxOutputBytes: MAX_PROCESS_OUTPUT}},
    renderHelp: prefix => renderCommandHelp("yt", ytCommand, {prefix, title: "🎵 YouTube 单曲下载器"}),
    commands: {yt: ytCommand}, settings,
    setup: migrateLegacyAi,
    services: {download_mp3: {description: "下载并发送一首有界的 YouTube MP3", async handle(input, context, signal): Promise<DownloadResult> {
      const request = serviceRequest(input);
      return downloadAndSend(context, request.message, request.query, request.options, request.preferred, signal, dependencies);
    }}},
  });
}
