import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type PluginContext, type SubcommandDefinition} from "telebox/sdk";
import {access, open, stat} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import type {Api as ApiTypes} from "teleproto";

const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const FFPROBE = ["/usr/bin/ffprobe", "/usr/local/bin/ffprobe", "/opt/homebrew/bin/ffprobe"] as const;
const ITUNES_HOSTS = ["itunes.apple.com", "is1-ssl.mzstatic.com", "is2-ssl.mzstatic.com", "is3-ssl.mzstatic.com", "is4-ssl.mzstatic.com", "is5-ssl.mzstatic.com"] as const;
const defaults = {schemaVersion: 1, apiKey: "", legacyImported: false, aiMigrated: false};

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;"})[character]!);
const filename = (value: string): string => value.replace(/[^\p{L}\p{N}\s._-]/gu, "").replace(/\s+/g, "_").slice(0, 100) || "audio";

async function runHelper(context: PluginContext, candidates: readonly string[], args: readonly string[], timeoutMs: number) {
  for (const command of candidates) {
    try { return await context.processes.run(command, args, {timeoutMs, maxOutputBytes: 256 * 1024}); }
    catch (error) {
      context.signal.throwIfAborted();
      if ((error as {code?: unknown})?.code !== "SPAWN_FAILED") throw error;
      try { await access(command, constants.F_OK); } catch { continue; }
      throw error;
    }
  }
  throw new Error("Helper unavailable");
}

async function streamFile(response: Response, target: string, signal: AbortSignal, maximum: number): Promise<void> {
  if (!response.ok || !response.body) throw new Error("Download failed");
  const handle = await open(target, "wx", 0o600);
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) throw new Error("Download too large");
      await handle.write(item.value);
    }
  } finally { await reader.cancel().catch(() => undefined); await handle.close(); }
}

async function configuration(context: PluginContext) {
  const store = context.storage.json("config.json", defaults);
  let current = await store.read();
  if (!current.legacyImported) {
    let legacy = "";
    try {
      legacy = await context.storage.sqlite("gemini_config.db").read(db =>
        String((db.prepare("SELECT value FROM config WHERE key = ?").get("convert_gemini_api_key") as any)?.value ?? ""));
    } catch {}
    current = await store.update(value => ({...value, schemaVersion: 1, apiKey: value.apiKey || legacy, legacyImported: true, aiMigrated: false}));
  }
  return {store, current};
}
async function migrateAi(context: PluginContext): Promise<void> {
  const loaded = await configuration(context); const current = loaded.current;
  if (current.aiMigrated) return;
  if (!current.apiKey) {await loaded.store.update(value => ({...value, apiKey:"", aiMigrated:true})); return;}
  if (!context.services.available("ai", "import_provider")) return;
  await context.services.call("ai", "import_provider", {tag:"convert", url:"https://generativelanguage.googleapis.com/v1beta",
    key:current.apiKey, type:"gemini", models:{search:"gemini-1.5-flash-latest"}, select:["search"]}, context.signal);
  await loaded.store.update(value => ({...value, apiKey:"", aiMigrated:true}));
  try {await context.storage.sqlite("gemini_config.db").transaction(db => {
    db.prepare("UPDATE config SET value = ? WHERE key = ?").run("", "convert_gemini_api_key");
  }, context.signal);} catch {}
}

type Song = {title: string; artist: string; album: string};
function song(value: unknown, fallback: string): Song {
  const text = typeof value === "string" ? value : "";
  const field = (name: string): string => text.split(/\r?\n/).find(line => line.includes(name))?.split(/[:：]/, 2)[1]?.trim() ?? "";
  return {title: field("歌曲名") || fallback, artist: field("歌手") || "未知", album: field("专辑") || "未知"};
}

async function identify(context: PluginContext, query: string): Promise<Song> {
  if (!context.services.available("ai", "search")) throw new Error("AI search unavailable");
  const result = await context.services.call<{text?:string}>("ai", "search", {text:`Find precise song information for: ${query}`,
    systemPrompt:"Return only three lines: 歌曲名, 歌手, 专辑. Use 未知 when unknown."}, context.signal);
  return song(result?.text, query);
}

async function cover(context: PluginContext, query: string, target: string): Promise<boolean> {
  try {
    const search = new URL("https://itunes.apple.com/search");
    search.searchParams.set("term", query); search.searchParams.set("entity", "song"); search.searchParams.set("limit", "1");
    const response = await context.http.json<any>(search, {}, {timeoutMs: 15_000,
      redirects: {allowedHosts: ITUNES_HOSTS, maxRedirects: 2}});
    const raw = response?.results?.[0]?.artworkUrl100;
    if (typeof raw !== "string") return false;
    const image = new URL(raw.replace("100x100bb.jpg", "600x600bb.jpg"));
    if (!ITUNES_HOSTS.includes(image.hostname as any) || image.protocol !== "https:") return false;
    await context.http.withResponse(image, {credentials: "omit"}, (result, signal) => streamFile(result, target, signal, 5 * 1024 * 1024),
      {timeoutMs: 20_000, redirects: {allowedHosts: ITUNES_HOSTS, maxRedirects: 2}});
    return true;
  } catch { return false; }
}

async function runConvert(invocation: any, context: PluginContext, ai: boolean) {
  const message = invocation.message;
  if (message.replyToId === undefined) {
    await context.telegram.edit(message, renderCommandHelp("convert", convertCommand, {prefix: invocation.prefix, title: "🎬 视频转音频 AI 助手"}), {parseMode: "html"});
    return;
  }
  try {
    const reply = await context.telegram.getReply(message);
    const source = reply?.raw as ApiTypes.Message | undefined;
    if (!source?.media || (!source.document && !source.video)) throw new Error("Video required");
    await context.files.withTemp(async (directory, signal) => {
      const input = path.join(directory, "video-input");
      const rawMp3 = path.join(directory, "audio.mp3");
      const finalMp3 = path.join(directory, "final.mp3");
      const coverFile = path.join(directory, "cover.jpg");
      await context.telegram.edit(message, "正在下载视频…");
      await context.telegram.withClient(client => client.downloadMedia(source.media!, {outputFile: input}));
      signal.throwIfAborted();
      await context.telegram.edit(message, "正在转换为 MP3…");
      await runHelper(context, FFMPEG, ["-nostdin", "-y", "-i", input, "-vn", "-c:a", "libmp3lame", "-q:a", "2", rawMp3], 180_000);
      const query = invocation.args.join(" ").trim();
      const original = (source.document as any)?.attributes?.find((entry: any) => typeof entry?.fileName === "string")?.fileName ?? "video";
      let metadata: Song = {title: query || String(original).replace(/\.[^.]+$/, ""), artist: "Video Converter", album: ""};
      let output = rawMp3, coverFound = false;
      if (ai) {
        if (!query) throw new Error("Query required");
        await migrateAi(context);
        if (!context.services.available("ai", "search")) throw new Error("AI search unavailable");
        await context.telegram.edit(message, "正在识别歌曲信息…");
        metadata = await identify(context, query);
        coverFound = await cover(context, `${metadata.title} ${metadata.artist}`, coverFile);
        const args = ["-nostdin", "-y", "-i", rawMp3];
        if (coverFound) args.push("-i", coverFile, "-map", "0:a", "-map", "1:v", "-c:a", "copy", "-c:v", "mjpeg", "-disposition:v:0", "attached_pic");
        else args.push("-c:a", "copy");
        args.push("-id3v2_version", "3", "-metadata", `title=${metadata.title}`, "-metadata", `artist=${metadata.artist}`,
          "-metadata", `album=${metadata.album}`, finalMp3);
        await runHelper(context, FFMPEG, args, 120_000); output = finalMp3;
      }
      const info = await stat(output);
      if (!info.isFile() || info.size === 0 || info.size > 2 * 1024 * 1024 * 1024) throw new Error("Invalid output");
      let duration = 0;
      try { duration = Math.max(0, Math.round(Number((await runHelper(context, FFPROBE,
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input], 30_000)).stdout.toString("utf8").trim()) || 0)); } catch {}
      await context.telegram.withClient(async client => {
        const {Api} = await import("teleproto");
        const raw = message.raw as ApiTypes.Message | undefined;
        if (!raw?.peerId) throw new Error("Missing peer");
        await client.sendFile(raw.peerId, {file: output, thumb: coverFound ? coverFile : undefined, forceDocument: false,
          replyTo: message.replyToId, attributes: [new Api.DocumentAttributeAudio({duration,
            title: metadata.title || filename(query), performer: metadata.artist || "Video Converter"})]});
        if (typeof raw.delete === "function") await raw.delete({revoke: true});
      });
    });
  } catch {
    if (context.signal.aborted) return;
    context.log.error("convert_failed");
    await context.telegram.edit(message, "转换失败，请确认回复的是视频、辅助程序已安装且外部服务配置有效");
  }
}

const apikey: SubcommandDefinition = {
  description: "查看统一 AI 配置方式", args: "", examples: [{args: "apikey"}],
  async handle(invocation, context) {
    await context.telegram.edit(invocation.message,
      `供应商、密钥与搜索模型由 ai 插件统一管理，请使用 ${invocation.prefix}ai config 与 ${invocation.prefix}ai model search。`);
  },
};
const u: SubcommandDefinition = {
  description: "AI 智能识别并转换", args: "歌曲名",
  arguments: [{name: "歌曲名", required: true, description: "用于 AI 查找元数据与封面的歌曲名"}],
  examples: [{args: "u 稻香"}],
  async handle(invocation, context) { await runConvert(invocation, context, true); },
};
const clear: SubcommandDefinition = {
  description: "清理临时文件", args: "", examples: [{args: "clear"}],
  async handle(invocation, context) { await context.telegram.edit(invocation.message, "临时文件由 V2 作用域自动清理"); },
};

const convertCommand: CommandDefinition = {
  description: "将回复视频转换为 MP3",
  helpArgs: ["help", "h"],
  args: "[文件名]",
  arguments: [{name: "文件名", description: "可选，自定义输出 MP3 文件名；AI 模式使用 u 子命令"}],
  examples: [{args: "", description: "回复视频后按原名转换"}, {args: "周杰伦-稻香-演唱会版", description: "自定义输出文件名"}],
  subcommandsCaseSensitive: false,
  subcommands: {u, apikey, clear},
  help: [
    {heading: "说明：", body: "回复视频后发送本命令即可转换为 MP3；不使用 <code>u</code> 时可直接指定输出文件名，不提供文件名则使用视频原名。AI 智能识别、自定义文件名、高质量音轨转 MP3，以及元数据嵌入（歌曲名、歌手、专辑和封面）。"},
    {heading: "AI 配置：", body: "智能识别使用 ai 插件当前搜索供应商和模型；请先通过 <code>{prefix}ai config</code> 与 <code>{prefix}ai model search</code> 完成统一配置。"},
  ],
  async handle(invocation, context) {
    const first = invocation.args[0]?.toLowerCase();
    if (first === "help" || first === "h" || (!invocation.args.length && invocation.message.replyToId === undefined)) {
      await context.telegram.edit(invocation.message, renderCommandHelp("convert", convertCommand, {prefix: invocation.prefix, title: "🎬 视频转音频 AI 助手"}), {parseMode: "html"});
      return;
    }
    await runConvert(invocation, context, false);
  },
};

export default function createConvert() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "convert", description: "将回复视频流式转换为 MP3，可用统一 AI 服务补充元数据",
    resources: {processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 180_000, maxOutputBytes: 256 * 1024}},
    renderHelp: prefix => renderCommandHelp("convert", convertCommand, {prefix, title: "🎬 视频转音频 AI 助手"}),
    commands: {convert: convertCommand}, setup: migrateAi,
  });
}
