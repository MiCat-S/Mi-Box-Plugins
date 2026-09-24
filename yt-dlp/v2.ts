import {
  STRUCTURED_PLUGIN_API_VERSION,
  definePlugin,
  renderCommandHelp,
  requireSdkFeatures,
  type CommandDefinition,
  type MessageEnvelope,
  type PluginContext,
  type PluginDefinition,
} from "telebox/sdk";
import { downloadAndSend, type DownloadDependencies, type DownloadOptions, type SongMetadata } from "./v2/download";
export { downloadAndSend } from "./v2/download";
requireSdkFeatures("legacySqlite");
const LEGACY_DB = "ytdlp_gemini_config.db",
  LEGACY_KEY = "ytdlp_gemini_api_key",
  MAX_UPLOAD = 50 * 1024 * 1024,
  MAX_COOKIE = 512 * 1024;
type State = {
  schemaVersion: 1;
  aiEnabled: boolean;
  maxDurationSeconds: number;
  maxUploadBytes: number;
  legacyAiMigrated: boolean;
  importedAiTag?: string;
  [key: string]: unknown;
};
const defaults = (): State => ({
  schemaVersion: 1,
  aiEnabled: true,
  maxDurationSeconds: 900,
  maxUploadBytes: MAX_UPLOAD,
  legacyAiMigrated: false,
});
const store = (c: PluginContext) => c.storage.json<State>("config.json", defaults());
const normalized = (v: any): State => ({
  ...v,
  schemaVersion: 1,
  aiEnabled: typeof v?.aiEnabled === "boolean" ? v.aiEnabled : true,
  maxDurationSeconds:
    Number.isSafeInteger(v?.maxDurationSeconds) && v.maxDurationSeconds >= 60 && v.maxDurationSeconds <= 1800
      ? v.maxDurationSeconds
      : 900,
  maxUploadBytes:
    Number.isSafeInteger(v?.maxUploadBytes) && v.maxUploadBytes >= 1048576 && v.maxUploadBytes <= MAX_UPLOAD
      ? v.maxUploadBytes
      : MAX_UPLOAD,
  legacyAiMigrated: v?.legacyAiMigrated === true,
});
const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
function geminiUrl(v: string) {
  try {
    const u = new URL(v.trim() || "https://generativelanguage.googleapis.com");
    if (u.hostname === "generativelanguage.googleapis.com" && ["", "/"].includes(u.pathname)) u.pathname = "/v1beta";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "https://generativelanguage.googleapis.com/v1beta";
  }
}
export async function migrateLegacyAi(c: PluginContext) {
  if (normalized(await store(c).read()).legacyAiMigrated) return;
  const legacy = c.storage.legacySqlite(LEGACY_DB);
  let values: Record<string, string>;
  try {
    const check = await legacy.preflight({ config: ["key", "value"] }, c.signal);
    if (!check.compatible) throw new Error("INVALID_LEGACY_DB");
    values = await legacy.read(
      db =>
        Object.fromEntries(
          (
            db
              .prepare("SELECT key, value FROM config WHERE key IN (?, ?, ?)")
              .all(LEGACY_KEY, "ytdlp_gemini_base_url", "ytdlp_gemini_model") as { key: string; value: string }[]
          ).map(row => [row.key, row.value]),
        ),
      c.signal,
    );
  } catch (e) {
    c.signal.throwIfAborted();
    if (!missing(e)) throw e;
    await store(c).update(v => ({ ...normalized(v), legacyAiMigrated: true }), c.signal);
    return;
  }
  const key = String(values[LEGACY_KEY] ?? "").trim();
  if (!key) {
    await store(c).update(v => ({ ...normalized(v), legacyAiMigrated: true }), c.signal);
    return;
  }
  if (!c.services.available("ai", "import_provider")) return;
  try {
    const result = await c.services.call<{ tag?: unknown }>(
      "ai",
      "import_provider",
      {
        tag: "yt-dlp",
        type: "gemini",
        key,
        url: geminiUrl(String(values.ytdlp_gemini_base_url ?? "")),
        stream: false,
        responses: false,
        models: { chat: String(values.ytdlp_gemini_model ?? "").trim() || "gemini-2.0-flash" },
        select: ["chat"],
      },
      c.signal,
    );
    c.signal.throwIfAborted();
    await legacy.transaction(db => {
      db.prepare("UPDATE config SET value = '' WHERE key = ?").run(LEGACY_KEY);
    }, c.signal);
    c.signal.throwIfAborted();
    await store(c).update(
      v => ({
        ...normalized(v),
        legacyAiMigrated: true,
        ...(typeof result.tag === "string" ? { importedAiTag: result.tag } : {}),
      }),
      c.signal,
    );
  } catch {
    c.signal.throwIfAborted();
    c.log.error("yt_dlp_ai_migration_failed");
  }
}
function record(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function manual(q: string): SongMetadata | undefined {
  if (q.includes("://")) return;
  const m = /^(.+?)\s*[-–—|·]\s*(.+)$/.exec(q);
  return m ? { title: m[1]!.trim(), artist: m[2]!.trim() } : undefined;
}
function aiMetadata(v: unknown): SongMetadata | undefined {
  if (typeof v !== "string") return;
  const fields: Record<string, string> = {};
  for (const line of v.split(/\r?\n/)) {
    const m = /^\s*(歌曲名|歌手|专辑)\s*[:：]\s*(.*?)\s*$/.exec(line);
    if (m?.[2] && m[2] !== "未知") fields[m[1]!] = m[2];
  }
  return fields.歌曲名 && fields.歌手
    ? {
        title: fields.歌曲名.slice(0, 200),
        artist: fields.歌手.slice(0, 200),
        ...(fields.专辑 ? { album: fields.专辑.slice(0, 200) } : {}),
      }
    : undefined;
}
async function recognize(c: PluginContext, q: string, enabled: boolean) {
  const local = manual(q);
  if (local || !enabled || q.includes("://") || !c.services.available("ai", "chat")) return local;
  try {
    return aiMetadata(
      await c.services.call(
        "ai",
        "chat",
        {
          text: q,
          systemPrompt: "识别歌曲信息。仅按三行返回：歌曲名: 名称；歌手: 姓名；专辑: 名称或未知。不要添加其他内容。",
          temperature: 0.2,
          maxOutputTokens: 256,
        },
        c.signal,
      ),
    );
  } catch {
    c.signal.throwIfAborted();
    return;
  }
}
function request(input: unknown) {
  const v = record(input),
    message = record(v.message),
    query = typeof v.query === "string" ? v.query.trim() : "",
    chatId = typeof message.chatId === "string" ? message.chatId : "";
  if (
    !query ||
    query.length > 300 ||
    /[\u0000-\u001f]/.test(query) ||
    !Number.isSafeInteger(message.id) ||
    !/^-?\d+$/.test(chatId) ||
    !message.raw
  )
    throw new Error("INVALID_SERVICE_INPUT");
  const raw = record(v.options),
    cookie = typeof raw.cookie === "string" ? raw.cookie : "",
    proxy = typeof raw.proxy === "string" ? raw.proxy : "",
    quality = typeof raw.quality === "string" ? raw.quality.toLowerCase() : "",
    maxDurationSeconds = Number(raw.maxDurationSeconds),
    maxUploadBytes = Number(raw.maxUploadBytes);
  if (
    cookie.length > MAX_COOKIE ||
    proxy.length > 2048 ||
    !/^(?:|[0-9]|10|64k|96k|128k|160k|192k|256k|320k)$/.test(quality) ||
    !Number.isSafeInteger(maxDurationSeconds) ||
    maxDurationSeconds < 60 ||
    maxDurationSeconds > 1800 ||
    !Number.isSafeInteger(maxUploadBytes) ||
    maxUploadBytes < 1048576 ||
    maxUploadBytes > MAX_UPLOAD
  )
    throw new Error("INVALID_SERVICE_INPUT");
  const p = v.preferred === undefined ? undefined : record(v.preferred);
  let preferred: SongMetadata | undefined;
  if (p) {
    const title = typeof p.title === "string" ? p.title.trim() : "",
      artist = typeof p.artist === "string" ? p.artist.trim() : "",
      album = typeof p.album === "string" ? p.album.trim() : undefined;
    if (!title || !artist || title.length > 200 || artist.length > 200 || (album?.length ?? 0) > 200)
      throw new Error("INVALID_SERVICE_INPUT");
    preferred = { title, artist, ...(album ? { album } : {}) };
  }
  return {
    query,
    message: v.message as MessageEnvelope,
    ...(preferred ? { preferred } : {}),
    options: { cookie, proxy, quality, maxDurationSeconds, maxUploadBytes } as DownloadOptions,
  };
}
async function receipt(c: PluginContext, m: MessageEnvelope) {
  const raw = m.raw as any;
  if (typeof raw?.delete !== "function") return;
  try {
    await c.telegram.withClient(async (_client, signal) => {
      signal.throwIfAborted();
      await raw.delete({ revoke: true });
      signal.throwIfAborted();
    });
  } catch {
    if (!c.signal.aborted) c.log.info("yt_dlp_receipt_cleanup_failed");
  }
}
function failureCode(e: unknown) {
  return e instanceof Error &&
    [
      "DEPENDENCY_MISSING",
      "INVALID_QUERY",
      "INVALID_URL",
      "INVALID_COOKIE",
      "INVALID_PROXY",
      "UNSUPPORTED_MEDIA",
      "MEDIA_TOO_LARGE",
      "NO_RESULT",
      "AMBIGUOUS_RESULT",
      "WORKSPACE_LIMIT",
      "INVALID_OUTPUT",
      "MISSING_PEER",
    ].includes(e.message)
    ? e.message
    : "FAILED";
}
export default function createYtDlp(deps: DownloadDependencies = {}): PluginDefinition {
  let command!: CommandDefinition;
  command = {
    description: "搜索并下载 YouTube 单曲 MP3",
    args: "关键词或 YouTube URL",
    helpOnEmpty: true,
    helpArgs: ["help", "h"],
    ignoreEdited: true,
    subcommands: {
      apikey: {
        description: "统一 AI 配置说明",
        async handle(i, c) {
          await c.telegram.edit(i.message, `Gemini/API Key 已由 ai 插件统一管理，请使用 ${i.prefix}ai config。`);
        },
      },
      update: {
        description: "安全更新说明",
        async handle(i, c) {
          await c.telegram.edit(
            i.message,
            "V2 不会下载或自更新可执行文件。请由系统管理员通过受信任的软件包渠道更新 yt-dlp。",
          );
        },
      },
    },
    async handle(i, c) {
      const query = i.args.join(" ").trim();
      if (!query) {
        await c.telegram.edit(i.message, renderCommandHelp("yt", command, { prefix: i.prefix }), { parseMode: "html" });
        return;
      }
      const state = normalized(await store(c).read());
      try {
        const metadata = await recognize(c, query, state.aiEnabled);
        await c.telegram.edit(
          i.message,
          metadata ? `已识别：${metadata.title} - ${metadata.artist}\n正在下载…` : "正在搜索并下载音乐…",
        );
        const search = metadata && !query.includes("://") ? `${metadata.artist} ${metadata.title}` : query;
        await downloadAndSend(
          c,
          i.message,
          search,
          {
            cookie: "",
            proxy: "",
            quality: "",
            maxDurationSeconds: state.maxDurationSeconds,
            maxUploadBytes: state.maxUploadBytes,
          },
          metadata,
          c.signal,
          deps,
        );
        await receipt(c, i.message);
      } catch (e) {
        if (c.signal.aborted) return;
        const code = failureCode(e);
        c.log.error("yt_dlp_download_failed", { code });
        await c.telegram.edit(
          i.message,
          code === "DEPENDENCY_MISSING"
            ? "缺少 yt-dlp 或 FFmpeg；请由系统管理员预先安装后重试"
            : "下载失败；请检查关键词、链接、时长、文件大小和网络后重试",
        );
      }
    },
  };
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "yt-dlp",
    description: "搜索并下载 YouTube 单曲 MP3",
    legacyStorage: { sqlite: [LEGACY_DB] },
    resources: { processes: { concurrency: 1, queueCapacity: 2, timeoutMs: 180000, maxOutputBytes: 512 * 1024 } },
    renderHelp: p => renderCommandHelp("yt", command, { prefix: p, title: "🎵 YouTube 单曲下载器" }),
    commands: { yt: command },
    setup: migrateLegacyAi,
    services: {
      download_mp3: {
        description: "下载并发送一首有界的 YouTube MP3",
        async handle(input, c, signal) {
          const r = request(input);
          return downloadAndSend(c, r.message, r.query, r.options, r.preferred, signal, deps);
        },
      },
    },
  });
}
