import { readFile, rename, writeFile } from "node:fs/promises";
import {
  STRUCTURED_PLUGIN_API_VERSION,
  definePlugin,
  renderCommandHelp,
  type CommandDefinition,
  type CommandInvocation,
  type PluginContext,
  type PluginDefinition,
} from "telebox/sdk";

const MAX_COOKIE = 512 * 1024,
  MAX_UPLOAD = 50 * 1024 * 1024;
const qualities = [
  "",
  ...Array.from({ length: 11 }, (_, i) => String(i)),
  "64k",
  "96k",
  "128k",
  "160k",
  "192k",
  "256k",
  "320k",
];
type Metadata = { title: string; artist: string; album?: string };
type LegacyAi = { key: string; url: string; model: string };
type State = {
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
  [key: string]: unknown;
};
type Dependencies = {
  scrubLegacyKey?: (file: string, raw: Record<string, unknown>, signal: AbortSignal) => Promise<void>;
};
const defaults = (): State => ({
  schemaVersion: 1,
  cookie: "",
  proxy: "",
  quality: "",
  aiEnabled: true,
  maxDurationSeconds: 900,
  maxUploadBytes: MAX_UPLOAD,
  legacyMigrated: false,
  aiMigrated: false,
});
const store = (c: PluginContext) => c.storage.json<State>("config.json", defaults());
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
function quality(v: unknown) {
  const x = String(v ?? "")
    .trim()
    .toLowerCase();
  if (["auto", "best", "none", "clear"].includes(x)) return "";
  if (/^(?:[0-9]|10)$/.test(x)) return x;
  const m = /^(64|96|128|160|192|256|320)\s*(?:k|kb|kbps)?$/.exec(x);
  return m ? `${m[1]}k` : undefined;
}
function proxy(v: unknown) {
  const x = String(v ?? "").trim();
  if (["", "none", "clear"].includes(x.toLowerCase())) return "";
  if (x.length > 2048) return;
  try {
    const u = new URL(x);
    return ["http:", "https:", "socks5:", "socks5h:"].includes(u.protocol) && u.hostname ? x : undefined;
  } catch {
    return;
  }
}
function normalize(v: any): State {
  const d = defaults();
  return {
    ...v,
    schemaVersion: 1,
    cookie: typeof v?.cookie === "string" && v.cookie.length <= MAX_COOKIE ? v.cookie : "",
    proxy: proxy(v?.proxy) ?? "",
    quality: quality(v?.quality) ?? "",
    aiEnabled: typeof v?.aiEnabled === "boolean" ? v.aiEnabled : true,
    maxDurationSeconds:
      Number.isSafeInteger(v?.maxDurationSeconds) && v.maxDurationSeconds >= 60 && v.maxDurationSeconds <= 1800
        ? v.maxDurationSeconds
        : d.maxDurationSeconds,
    maxUploadBytes:
      Number.isSafeInteger(v?.maxUploadBytes) && v.maxUploadBytes >= 1048576 && v.maxUploadBytes <= MAX_UPLOAD
        ? v.maxUploadBytes
        : d.maxUploadBytes,
    legacyMigrated: v?.legacyMigrated === true,
    aiMigrated: v?.aiMigrated === true,
  };
}
function legacyValue(v: Record<string, unknown>, key: string) {
  for (const source of [v, record(v.settings), record(v.apiKeys), record(v.cookies)])
    if (typeof source[key] === "string") return String(source[key]);
  if (key === "music_gemini_api_key" && typeof record(v.settings).apikey === "string")
    return String(record(v.settings).apikey);
  return "";
}
async function optional(file: string, signal: AbortSignal) {
  try {
    const raw = JSON.parse(await readFile(file, { encoding: "utf8", signal }));
    signal.throwIfAborted();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_MUSIC_CONFIG");
    return record(raw);
  } catch (e) {
    signal.throwIfAborted();
    if (missing(e)) return;
    throw e;
  }
}
function geminiUrl(v: string) {
  try {
    const u = new URL(v.trim() || "https://generativelanguage.googleapis.com");
    if (u.hostname === "generativelanguage.googleapis.com" && ["", "/"].includes(u.pathname)) u.pathname = "/v1beta";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "https://generativelanguage.googleapis.com/v1beta";
  }
}
async function scrub(file: string, raw: Record<string, unknown>, signal: AbortSignal) {
  for (const source of [raw, record(raw.settings), record(raw.apiKeys)]) {
    if (Object.hasOwn(source, "music_gemini_api_key")) source.music_gemini_api_key = "";
    if (source === record(raw.settings) && Object.hasOwn(source, "apikey")) source.apikey = "";
  }
  const temp = `${file}.v2-migration`;
  signal.throwIfAborted();
  await writeFile(temp, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600, signal });
  signal.throwIfAborted();
  await rename(temp, file);
  signal.throwIfAborted();
}
export async function migrate(c: PluginContext, deps: Dependencies = {}): Promise<void> {
  let state = normalize(await store(c).read());
  const legacyPath = c.files.dataPath("music_config.json");
  let legacy: Record<string, unknown> | undefined;
  if (!state.legacyMigrated) {
    const explicit = (await optional(c.files.dataPath("config.json"), c.signal)) ?? {};
    legacy = await optional(legacyPath, c.signal);
    const source = { ...defaults(), ...explicit };
    if (legacy) {
      source.cookie = String(explicit.cookie ?? legacyValue(legacy, "music_ytdlp_cookie"));
      source.proxy = String(explicit.proxy ?? legacyValue(legacy, "music_ytdlp_proxy"));
      source.quality = String(explicit.quality ?? legacyValue(legacy, "music_audio_quality"));
      const key = legacyValue(legacy, "music_gemini_api_key").trim();
      if (key && !Object.hasOwn(explicit, "legacyAi"))
        source.legacyAi = {
          key,
          url: geminiUrl(legacyValue(legacy, "music_gemini_base_url")),
          model: legacyValue(legacy, "music_gemini_model").trim() || "gemini-2.0-flash",
        };
      source.aiMigrated = explicit.aiMigrated === true || !key;
    } else source.aiMigrated = true;
    c.signal.throwIfAborted();
    state = await store(c).update(
      current => (current.legacyMigrated ? current : normalize({ ...source, legacyMigrated: true })),
      c.signal,
    );
  }
  if (state.aiMigrated || !state.legacyAi?.key || !c.services.available("ai", "import_provider")) return;
  try {
    const result = await c.services.call<{ tag?: unknown }>(
      "ai",
      "import_provider",
      {
        tag: "music",
        url: state.legacyAi.url,
        key: state.legacyAi.key,
        type: "gemini",
        stream: false,
        responses: false,
        models: { chat: state.legacyAi.model },
        select: ["chat"],
      },
      c.signal,
    );
    legacy ??= await optional(legacyPath, c.signal);
    if (legacy) await (deps.scrubLegacyKey ?? scrub)(legacyPath, legacy, c.signal);
    await store(c).update(current => {
      const { legacyAi: _drop, ...rest } = normalize(current);
      return {
        ...rest,
        aiMigrated: true,
        ...(typeof result.tag === "string" ? { importedAiTag: result.tag } : {}),
      } as State;
    }, c.signal);
  } catch {
    c.signal.throwIfAborted();
    c.log.error("music_ai_migration_failed");
  }
}
function manual(q: string): Metadata | undefined {
  if (q.includes("://")) return;
  const p = q
    .split(/\s+[-–—]\s+/)
    .map(x => x.trim())
    .filter(Boolean);
  return p.length >= 2 ? { artist: p[0]!, title: p[1]!, ...(p[2] ? { album: p[2] } : {}) } : undefined;
}
function aiMetadata(v: unknown): Metadata | undefined {
  if (typeof v !== "string") return;
  const f: Record<string, string> = {};
  for (const line of v.split(/\r?\n/)) {
    const m = /^\s*(歌曲名|歌手|专辑)\s*[:：]\s*(.*?)\s*$/.exec(line);
    if (m?.[2] && m[2] !== "未知") f[m[1]!] = m[2];
  }
  return f.歌曲名 && f.歌手
    ? {
        title: f.歌曲名.slice(0, 200),
        artist: f.歌手.slice(0, 200),
        ...(f.专辑 ? { album: f.专辑.slice(0, 200) } : {}),
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
async function removeReceipt(c: PluginContext, i: CommandInvocation) {
  const raw = i.message.raw as { delete?: (o: { revoke: boolean }) => Promise<unknown> } | undefined;
  if (typeof raw?.delete !== "function") return;
  try {
    await c.telegram.withClient(async (_client, signal) => {
      signal.throwIfAborted();
      await raw.delete!({ revoke: true });
      signal.throwIfAborted();
    });
  } catch {
    if (!c.signal.aborted) c.log.info("music_receipt_cleanup_failed");
  }
}
function exactSettingValue(i: CommandInvocation, c: PluginContext): string {
  const protocol = i.message.raw as { message?: unknown; text?: unknown } | undefined;
  const source =
    typeof protocol?.message === "string"
      ? protocol.message
      : typeof protocol?.text === "string"
        ? protocol.text
        : i.message.text;
  const parsed = c.commands.parse(source);
  if (parsed?.command !== "music" || parsed.args[0]?.toLowerCase() !== "set" || !parsed.args[1])
    return i.args.join(" ");
  const wanted = i.args;
  if (!wanted.length) return "";
  const body = source.slice(parsed.prefix.length),
    tokens = [...body.matchAll(/\S+/gu)];
  if (tokens.length < wanted.length + 1) return i.args.join(" ");
  const start = tokens[tokens.length - wanted.length]?.index;
  return start === undefined ? i.args.join(" ") : body.slice(start).trimEnd();
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

export default function createMusic(deps: Dependencies = {}): PluginDefinition {
  let command!: CommandDefinition;
  const config = async (i: CommandInvocation, c: PluginContext) => {
    await migrate(c, deps);
    const s = normalize(await store(c).read());
    await c.telegram.edit(
      i.message,
      `<b>Music 配置</b>\nCookie：${s.cookie ? "已设置" : "未设置"}\n代理：${s.proxy ? "已设置" : "未设置"}\n音质：<code>${s.quality || "自动"}</code>\nAI 识别：${s.aiEnabled && c.services.available("ai", "chat") ? "可用" : s.aiEnabled ? "等待 ai.chat" : "已关闭"}\n时长上限：${s.maxDurationSeconds} 秒\n上传上限：${Math.floor(s.maxUploadBytes / 1048576)} MB`,
      { parseMode: "html", linkPreview: false },
    );
  };
  const secret = (key: "cookie" | "proxy") => async (i: CommandInvocation, c: PluginContext) => {
    const raw = exactSettingValue(i, c).trim();
    if (!i.message.saved) {
      await c.telegram.edit(i.message, "Cookie 或含凭据的代理只能在收藏夹中配置");
      return;
    }
    const value = key === "cookie" ? (["none", "clear"].includes(raw.toLowerCase()) ? "" : raw) : proxy(raw);
    if (value === undefined || (key === "cookie" && value.length > MAX_COOKIE)) {
      await c.telegram.edit(i.message, "配置值无效或过长");
      return;
    }
    await store(c).update(v => ({ ...normalize(v), [key]: value }));
    await c.telegram.edit(i.message, `${key === "cookie" ? "Cookie" : "代理"}已${value ? "设置" : "清除"}`);
  };
  const aiGuide = async (i: CommandInvocation, c: PluginContext) =>
    c.telegram.edit(
      i.message,
      `AI 供应商、密钥和模型由 ai 插件统一管理，请使用 ${i.prefix}ai config 与 ${i.prefix}ai model chat。`,
    );
  const set: CommandDefinition = {
    description: "设置下载配置",
    args: "cookie|proxy|quality ...",
    subcommands: {
      cookie: { description: "设置 Cookie", args: "值|clear", handle: secret("cookie") },
      proxy: { description: "设置代理", args: "URL|clear", handle: secret("proxy") },
      quality: {
        description: "设置音质",
        args: "0-10|64k-320k|auto",
        async handle(i, c) {
          const value = quality(i.args[0]);
          if (value === undefined) {
            await c.telegram.edit(i.message, "音质须为 0–10、64k–320k 或 auto");
            return;
          }
          await store(c).update(v => ({ ...normalize(v), quality: value }));
          await c.telegram.edit(i.message, `音质已设置为 ${value || "自动"}`);
        },
      },
      api_key: { description: "统一 AI 配置说明", handle: aiGuide },
      base_url: { aliases: ["baseurl"], description: "统一 AI 配置说明", handle: aiGuide },
      model: { description: "统一 AI 配置说明", handle: aiGuide },
    },
    async handle(i, c) {
      await c.telegram.edit(i.message, renderCommandHelp("music", command, { prefix: i.prefix, path: ["set"] }), {
        parseMode: "html",
      });
    },
  };
  command = {
    description: "搜索或通过 YouTube 链接下载单曲 MP3",
    args: "关键词或 YouTube URL",
    helpOnEmpty: true,
    helpArgs: ["help", "h"],
    ignoreEdited: true,
    subcommands: {
      config: { description: "查看配置", handle: config },
      set,
      clear: {
        description: "说明临时文件清理",
        async handle(i, c) {
          await c.telegram.edit(i.message, "临时文件由插件生命周期自动清理，当前没有保留文件。");
        },
      },
    },
    async handle(i, c) {
      const query = i.args.join(" ").trim();
      if (!query) {
        await c.telegram.edit(i.message, renderCommandHelp("music", command, { prefix: i.prefix }), {
          parseMode: "html",
        });
        return;
      }
      if (query.length > 300 || /[\u0000-\u001f]/.test(query)) {
        await c.telegram.edit(i.message, "搜索词无效或超过 300 字符");
        return;
      }
      if (!c.services.available("yt-dlp", "download_mp3")) {
        await c.telegram.edit(i.message, "music 需要 yt-dlp 插件提供下载服务；请先安装并启用 yt-dlp");
        return;
      }
      await migrate(c, deps);
      const state = normalize(await store(c).read());
      try {
        const metadata = await recognize(c, query, state.aiEnabled);
        await c.telegram.edit(
          i.message,
          metadata ? `已识别：${metadata.artist} - ${metadata.title}\n正在下载…` : "正在查找并下载音乐…",
        );
        const search = metadata && !query.includes("://") ? `${metadata.artist} ${metadata.title} lyrics` : query;
        await c.services.call(
          "yt-dlp",
          "download_mp3",
          {
            query: search,
            message: i.message,
            ...(metadata ? { preferred: metadata } : {}),
            options: {
              cookie: state.cookie,
              proxy: state.proxy,
              quality: state.quality,
              maxDurationSeconds: state.maxDurationSeconds,
              maxUploadBytes: state.maxUploadBytes,
            },
          },
          c.signal,
        );
        await removeReceipt(c, i);
      } catch (e) {
        if (c.signal.aborted) return;
        const code = failureCode(e);
        c.log.error("music_download_failed", { code });
        await c.telegram.edit(
          i.message,
          code === "DEPENDENCY_MISSING"
            ? "缺少 yt-dlp 或 FFmpeg；请由系统管理员预先安装后重试"
            : "音乐下载失败；请检查链接、时长、文件大小、Cookie、代理和网络后重试",
        );
      }
    },
  };
  const settings: NonNullable<PluginDefinition["settings"]> = c => ({
    id: "music",
    title: "YouTube Music",
    description: "下载限制、Cookie、代理与音质",
    category: "插件配置",
    icon: "🎵",
    getSchema: () => [
      { key: "cookie", label: "YouTube Cookie", type: "password", secret: true, max: MAX_COOKIE },
      { key: "proxy", label: "下载代理", type: "password", secret: true, max: 2048 },
      {
        key: "quality",
        label: "MP3 音质",
        type: "select",
        options: qualities.map(value => ({ value, label: value || "自动" })),
      },
      { key: "aiEnabled", label: "使用 ai.chat 识别", type: "boolean" },
      { key: "maxDurationSeconds", label: "最长时长", type: "number", min: 60, max: 1800 },
      { key: "maxUploadBytes", label: "最大上传字节", type: "number", min: 1048576, max: MAX_UPLOAD },
    ],
    getValues: async () => {
      const s = normalize(await store(c).read());
      return {
        cookie: s.cookie,
        proxy: s.proxy,
        quality: s.quality,
        aiEnabled: s.aiEnabled,
        maxDurationSeconds: s.maxDurationSeconds,
        maxUploadBytes: s.maxUploadBytes,
      };
    },
    async setValues(p, signal) {
      if (p.cookie !== undefined && (typeof p.cookie !== "string" || p.cookie.length > MAX_COOKIE))
        throw new Error("Invalid cookie");
      if (p.proxy !== undefined && (typeof p.proxy !== "string" || proxy(p.proxy) === undefined))
        throw new Error("Invalid proxy");
      if (p.quality !== undefined && (typeof p.quality !== "string" || quality(p.quality) === undefined))
        throw new Error("Invalid quality");
      if (p.aiEnabled !== undefined && typeof p.aiEnabled !== "boolean") throw new Error("Invalid AI setting");
      for (const [key, min, max] of [
        ["maxDurationSeconds", 60, 1800],
        ["maxUploadBytes", 1048576, MAX_UPLOAD],
      ] as const) {
        const value = p[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max))
          throw new Error("Invalid limit");
      }
      await store(c).update(
        v =>
          normalize({
            ...v,
            ...p,
            ...(p.proxy !== undefined ? { proxy: proxy(p.proxy)! } : {}),
            ...(p.quality !== undefined ? { quality: quality(p.quality)! } : {}),
          }),
        signal,
      );
    },
  });
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "music",
    description: "搜索并下载 YouTube 单曲 MP3",
    renderHelp: p => renderCommandHelp("music", command, { prefix: p, title: "🎵 YouTube 音乐下载器" }),
    commands: { music: command },
    settings,
    setup: c => migrate(c, deps),
  });
}
