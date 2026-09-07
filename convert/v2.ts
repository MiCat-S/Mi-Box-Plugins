import {access, open, stat} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const FFPROBE = ["/usr/bin/ffprobe", "/usr/local/bin/ffprobe", "/opt/homebrew/bin/ffprobe"] as const;
const GEMINI_HOST = "generativelanguage.googleapis.com";
const ITUNES_HOSTS = ["itunes.apple.com", "is1-ssl.mzstatic.com", "is2-ssl.mzstatic.com", "is3-ssl.mzstatic.com", "is4-ssl.mzstatic.com", "is5-ssl.mzstatic.com"] as const;
const defaults = {schemaVersion: 1, apiKey: "", legacyImported: false};

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

async function boundedJson(response: Response, signal: AbortSignal, maximum: number): Promise<any> {
  if (!response.ok || !response.body) throw new Error("Request failed");
  const reader = response.body.getReader(); const parts: Buffer[] = []; let total = 0;
  try { while (true) { signal.throwIfAborted(); const item = await reader.read(); if (item.done) break;
      total += item.value.byteLength; if (total > maximum) throw new Error("Response too large"); parts.push(Buffer.from(item.value)); } }
  finally { await reader.cancel().catch(() => undefined); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new Error("Invalid response"); }
}

async function configuration(context: PluginContext) {
  const store = context.storage.json("config.json", defaults);
  let current = await store.read();
  if (!current.legacyImported) {
    let legacy = "";
    try {
      legacy = await context.storage.sqlite("gemini_config.db", {readonly: true}).read(db =>
        String((db.prepare("SELECT value FROM config WHERE key = ?").get("convert_gemini_api_key") as any)?.value ?? ""));
    } catch {}
    current = await store.update(value => ({...value, schemaVersion: 1, apiKey: value.apiKey || legacy, legacyImported: true}));
  }
  return {store, current};
}

type Song = {title: string; artist: string; album: string};
function song(value: unknown, fallback: string): Song {
  const text = typeof value === "string" ? value : "";
  const field = (name: string): string => text.split(/\r?\n/).find(line => line.includes(name))?.split(/[:：]/, 2)[1]?.trim() ?? "";
  return {title: field("歌曲名") || fallback, artist: field("歌手") || "未知", album: field("专辑") || "未知"};
}

async function identify(context: PluginContext, key: string, query: string): Promise<Song> {
  const endpoint = `https://${GEMINI_HOST}/v1beta/models/gemini-1.5-flash-latest:generateContent`;
  const data = await context.http.withResponse(endpoint, {method: "POST", credentials: "omit",
    headers: {"x-goog-api-key": key, "content-type": "application/json"},
    body: JSON.stringify({contents: [{role: "user", parts: [{text: `Find precise song information for: ${query}`}]}],
      systemInstruction: {parts: [{text: "Return only three lines: 歌曲名, 歌手, 专辑. Use 未知 when unknown."}]}, tools: [{google_search: {}}]})},
  async (response, signal) => {
    const value = await boundedJson(response, signal, 2 * 1024 * 1024);
    return value?.candidates?.[0]?.content?.parts?.[0]?.text;
  }, {timeoutMs: 30_000, redirects: {allowedHosts: [GEMINI_HOST], maxRedirects: 0}});
  return song(data, query);
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

function help(prefix: string): string {
  return `<b>视频转 MP3</b>\n回复视频：<code>${escape(prefix)}convert [文件名]</code>\n` +
    `AI 元数据：<code>${escape(prefix)}convert u 歌曲名</code>\n` +
    `收藏夹设置密钥：<code>${escape(prefix)}convert apikey KEY</code>`;
}

export default function createConvert() {
  return definePlugin({apiVersion: 1, id: "convert", description: "将回复视频流式转换为 MP3，可选 AI 元数据",
    resources: {processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 180_000, maxOutputBytes: 256 * 1024}},
    settings: context => ({title: "视频转音频", description: "Gemini 元数据识别配置", category: "插件配置", icon: "🎬",
      getSchema: () => [{key: "apiKey", label: "Gemini API Key", type: "password", secret: true}],
      async getValues() { return {apiKey: (await configuration(context)).current.apiKey}; },
      async setValues(patch) { const key = patch.apiKey; if (typeof key === "string") await (await configuration(context)).store.update(value => ({...value, apiKey: key})); }}),
    commands: {convert: {description: "将回复视频转换为 MP3", async handle(invocation, context) {
      const sub = invocation.args[0]?.toLowerCase() ?? "";
      if (sub === "help" || sub === "h" || (!invocation.args.length && invocation.message.replyToId === undefined)) {
        await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return;
      }
      if (sub === "clear") { await context.telegram.edit(invocation.message, "临时文件由 V2 作用域自动清理"); return; }
      if (sub === "apikey") {
        if (!invocation.message.saved) { await context.telegram.edit(invocation.message, "请仅在收藏夹中设置 API Key"); return; }
        const supplied = invocation.args.slice(1).join(" ").trim();
        const {store, current} = await configuration(context);
        if (!supplied) { await context.telegram.edit(invocation.message, current.apiKey ? `当前 API Key：…${escape(current.apiKey.slice(-4))}` : "尚未设置 API Key", {parseMode: "html"}); return; }
        await store.update(value => ({...value, apiKey: supplied.toLowerCase() === "clear" ? "" : supplied}));
        await context.telegram.edit(invocation.message, supplied.toLowerCase() === "clear" ? "API Key 已清除" : "API Key 已保存"); return;
      }
      if (invocation.message.replyToId === undefined) { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
      try {
        const reply = await context.telegram.getReply(invocation.message);
        const source = reply?.raw as ApiTypes.Message | undefined;
        if (!source?.media || (!source.document && !source.video)) throw new Error("Video required");
        await context.files.withTemp(async (directory, signal) => {
          const input = path.join(directory, "video-input");
          const rawMp3 = path.join(directory, "audio.mp3");
          const finalMp3 = path.join(directory, "final.mp3");
          const coverFile = path.join(directory, "cover.jpg");
          await context.telegram.edit(invocation.message, "正在下载视频…");
          await context.telegram.withClient(client => client.downloadMedia(source.media!, {outputFile: input}));
          signal.throwIfAborted();
          await context.telegram.edit(invocation.message, "正在转换为 MP3…");
          await runHelper(context, FFMPEG, ["-nostdin", "-y", "-i", input, "-vn", "-c:a", "libmp3lame", "-q:a", "2", rawMp3], 180_000);
          const ai = sub === "u";
          const query = (ai ? invocation.args.slice(1) : invocation.args).join(" ").trim();
          const original = (source.document as any)?.attributes?.find((entry: any) => typeof entry?.fileName === "string")?.fileName ?? "video";
          let metadata: Song = {title: query || String(original).replace(/\.[^.]+$/, ""), artist: "Video Converter", album: ""};
          let output = rawMp3, coverFound = false;
          if (ai) {
            if (!query) throw new Error("Query required");
            const key = (await configuration(context)).current.apiKey;
            if (!key) throw new Error("API key required");
            await context.telegram.edit(invocation.message, "正在识别歌曲信息…");
            metadata = await identify(context, key, query);
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
            const raw = invocation.message.raw as ApiTypes.Message | undefined;
            if (!raw?.peerId) throw new Error("Missing peer");
            await client.sendFile(raw.peerId, {file: output, thumb: coverFound ? coverFile : undefined, forceDocument: false,
              replyTo: invocation.message.replyToId, attributes: [new Api.DocumentAttributeAudio({duration,
                title: metadata.title || filename(query), performer: metadata.artist || "Video Converter"})]});
            if (typeof raw.delete === "function") await raw.delete({revoke: true});
          });
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("convert_failed");
        await context.telegram.edit(invocation.message, "转换失败，请确认回复的是视频、辅助程序已安装且外部服务配置有效");
      }
    }}},
  });
}
