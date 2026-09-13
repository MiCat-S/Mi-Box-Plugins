import path from "node:path";
import {readFile, stat, writeFile} from "node:fs/promises";
import {definePlugin, STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, type PluginContext, type MessageEnvelope} from "telebox/sdk";
import type {Api} from "teleproto";

const HOST = "picupapi.tukeli.net";
const ENDPOINT = `https://${HOST}/api/v1/matting?mattingType=6&outputFormat=webp`;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 16_777_216;
const store = (ctx: PluginContext) => ctx.storage.json("config.json", {apiKey: ""});
class UserError extends Error {}

async function key(ctx: PluginContext): Promise<string> {
  const config = await store(ctx).read();
  return typeof config.apiKey === "string" && config.apiKey.trim() ? config.apiKey.trim() : (process.env.PICUP_API_KEY ?? "").trim();
}

export async function responseBytes(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new UserError("抠图结果超过 20 MiB");
  if (!response.body) throw new UserError("抠图服务返回空结果");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0, done = false;
  let cancelling: Promise<void> | undefined;
  const cancel = () => cancelling ??= reader.cancel().catch(() => undefined);
  const abort = () => {void cancel();};
  signal.addEventListener("abort", abort, {once: true});
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {done = true; break;}
      size += next.value.length;
      if (size > MAX_BYTES) throw new UserError("抠图结果超过 20 MiB");
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", abort);
    try {if (!done) await cancel();} finally {reader.releaseLock();}
  }
}

async function matting(ctx: PluginContext, apiKey: string, bytes: Buffer, mime: string) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], {type: mime}), mime === "image/png" ? "input.png" : "input.webp");
  return ctx.http.withResponse(ENDPOINT, {method: "POST", credentials: "omit", body: form,
    headers: {apikey: apiKey, accept: "*/*", "user-agent": "ProKnockOut/7.83 (iPhone; iOS 26.3; Scale/3.00)"}},
  async (response, signal) => {
    const data = await responseBytes(response, signal);
    const type = response.headers.get("content-type") ?? "";
    const failed = !response.ok || /json|text\//i.test(type);
    const retry = failed && (/"code"\s*:\s*5013/.test(data.toString("utf8")) || data.includes(Buffer.from("文件类型不支持")));
    return {failed, retry, data};
  }, {timeoutMs: 60_000, redirects: {allowedHosts: [HOST], maxRedirects: 0}});
}

async function input(ctx: PluginContext, message: MessageEnvelope, directory: string, signal: AbortSignal) {
  const reply = await ctx.telegram.getReply(message);
  const source = reply?.raw as Api.Message | undefined;
  const doc = source?.document;
  let mime = doc?.mimeType ?? (source?.photo ? "image/jpeg" : "");
  if (mime === "application/octet-stream") {
    const filename = doc?.attributes.find(value => "fileName" in value);
    const extension = filename && "fileName" in filename ? path.extname(String(filename.fileName)).toLowerCase() : "";
    mime = ({".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
      ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".tgs": "application/x-tgsticker"} as Record<string, string>)[extension] ?? mime;
  }
  if (mime === "application/x-tgsticker") throw new UserError("暂不支持 TGS 动态贴纸，请回复图片或视频贴纸");
  let bytes: Buffer;
  const media = Boolean(source?.photo || doc);
  if (media) {
    if (!/^image\//.test(mime) && !["video/mp4", "video/webm"].includes(mime)) throw new UserError("请回复图片、GIF、MP4 或 WebM");
    if (doc && BigInt(doc.size.toString()) > BigInt(MAX_BYTES)) throw new UserError("输入文件不能超过 20 MiB");
    bytes = await ctx.telegram.withClient(async (client, clientSignal) => {
      const chunks: Buffer[] = []; let total = 0;
      for await (const chunk of client.iterDownload(source!, {})) {
        signal.throwIfAborted(); clientSignal.throwIfAborted();
        total += chunk.length;
        if (total > MAX_BYTES) throw new UserError("输入文件不能超过 20 MiB");
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, total);
    });
  } else {
    bytes = await ctx.telegram.withClient(async client => {
      const {Api} = await import("teleproto");
      const target = reply ? await (reply.raw as Api.Message | undefined)?.getInputSender() : new Api.InputPeerSelf();
      if (!target) throw new UserError("无法取得回复者头像");
      const result = await client.downloadProfilePhoto(target, {isBig: false});
      if (!Buffer.isBuffer(result) || !result.length) throw new UserError("该用户没有可用头像");
      return result;
    });
  }
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > MAX_BYTES) throw new UserError("图片为空或超过 20 MiB");
  if (mime.startsWith("video/")) {
    const sourcePath = path.join(directory, mime === "video/mp4" ? "input.mp4" : "input.webm");
    const frame = path.join(directory, "frame.png");
    await writeFile(sourcePath, bytes, {flag: "wx", mode: 0o600, signal});
    await videoFrame(ctx, sourcePath, frame, directory, signal);
    if ((await stat(frame)).size > MAX_BYTES) throw new UserError("视频首帧超过 20 MiB");
    bytes = await readFile(frame, {signal});
  }
  const sharp = (await import("sharp")).default;
  const normalized = await sharp(bytes, {limitInputPixels: MAX_PIXELS, animated: false, pages: 1}).webp({lossless: true}).toBuffer();
  if (normalized.length > MAX_BYTES) throw new UserError("图片转换后超过 20 MiB");
  signal.throwIfAborted();
  return {bytes: normalized, reply};
}

export async function videoFrame(ctx: PluginContext, source: string, frame: string, directory: string, signal: AbortSignal) {
  for (const bin of ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]) {
    signal.throwIfAborted();
    let result;
    try {
      result = await ctx.processes.run(path.join(bin, "ffprobe"), ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "json", source], {cwd: directory, timeoutMs: 10000, maxOutputBytes: 65536});
    } catch (error) {
      signal.throwIfAborted();
      if (error && typeof error === "object" && "code" in error && error.code === "SPAWN_FAILED") continue;
      throw error;
    }
    const stream = JSON.parse(result.stdout.toString("utf8")).streams?.[0];
    if (!Number.isInteger(stream?.width) || !Number.isInteger(stream?.height) || stream.width <= 0 || stream.height <= 0 ||
        stream.width * stream.height > MAX_PIXELS) throw new UserError("视频尺寸无效或超过 16777216 像素");
    signal.throwIfAborted();
    await ctx.processes.run(path.join(bin, "ffmpeg"), ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-i", source,
      "-frames:v", "1", "-vf", "scale=2048:2048:force_original_aspect_ratio=decrease", "-fs", String(MAX_BYTES), frame],
    {cwd: directory, timeoutMs: 30000, maxOutputBytes: 65536});
    return;
  }
  throw new UserError("视频首帧处理需要服务器安装 FFmpeg 和 FFprobe");
}

export default function createKoutu() {
  let busy = false;
  const command: CommandDefinition = {
    description: "图片、贴纸或头像一键抠图", helpArgs: ["help", "h"], ignoreEdited: true,
    subcommands: {set: {description: "配置抠图服务", subcommands: {key: {
      description: "仅在收藏夹设置 PicUP API Key", args: "<apikey>", async handle(i, ctx) {
        if (!i.message.saved) {await ctx.telegram.edit(i.message, "请仅在收藏夹中设置 API Key"); return;}
        if (i.args.length !== 1 || !i.args[0].trim()) {await ctx.telegram.edit(i.message, `用法：${i.prefix}koutu set key <apikey>`); return;}
        await store(ctx).update(value => ({...value, apiKey: i.args[0].trim()}));
        await ctx.telegram.edit(i.message, "API Key 已保存");
      },
    }}, async handle(i, ctx) {await ctx.telegram.edit(i.message, `用法：${i.prefix}koutu set key <apikey>`);}}},
    help: [{heading: "使用方式", body: "回复图片或静态贴纸执行 <code>{prefix}koutu</code>；GIF、MP4、WebM 取首帧。回复文字取发送者头像，不回复取自己头像；不支持 TGS。"},
      {heading: "服务与限制", body: "图片会上传至 picupapi.tukeli.net，使用你配置的 API Key，可能消耗服务额度。输入和结果上限 20 MiB，图片解码上限 16777216 像素；视频需 FFmpeg。同一时间处理一个任务。兼容原 config.json 的 apiKey 及 PICUP_API_KEY 环境变量。"}],
    async handle(i, ctx) {
      if (i.args.length) {await ctx.telegram.edit(i.message, renderCommandHelp("koutu", command, {prefix: i.prefix}), {parseMode: "html"}); return;}
      if (busy) {await ctx.telegram.edit(i.message, "已有抠图任务正在处理，请稍后重试"); return;}
      busy = true;
      try {
        const apiKey = await key(ctx);
        if (!apiKey) {await ctx.telegram.edit(i.message, `请先在收藏夹执行 ${i.prefix}koutu set key <apikey>`); return;}
        await ctx.telegram.edit(i.message, "正在抠图…");
        await ctx.files.withTemp(async (directory, signal) => {
          const selected = await input(ctx, i.message, directory, signal);
          let result = await matting(ctx, apiKey, selected.bytes, "image/webp");
          const sharp = (await import("sharp")).default;
          if (result.retry) {
            const png = await sharp(selected.bytes, {limitInputPixels: MAX_PIXELS}).png().toBuffer();
            if (png.length > MAX_BYTES) throw new UserError("PNG 图片超过 20 MiB");
            signal.throwIfAborted();
            result = await matting(ctx, apiKey, png, "image/png");
          }
          if (result.failed) throw new UserError("抠图服务请求失败，请检查 API Key、额度和图片格式");
          const output = await sharp(result.data, {limitInputPixels: MAX_PIXELS, pages: 1}).webp({lossless: true}).toBuffer();
          if (!output.length || output.length > MAX_BYTES) throw new UserError("抠图结果为空或超过 20 MiB");
          signal.throwIfAborted();
          await ctx.telegram.withClient(async (client, clientSignal) => {
            clientSignal.throwIfAborted();
            const {CustomFile} = await import("teleproto/client/uploads.js");
            const raw = i.message.raw as Api.Message;
            await client.sendFile(raw.peerId!, {file: new CustomFile("koutu.webp", output.length, "", output),
              forceDocument: true, replyTo: selected.reply?.id, topMsgId: i.message.topicId});
          });
        });
        try {await (i.message.raw as Api.Message).delete({revoke: true});}
        catch {ctx.log.info("koutu_receipt_cleanup_failed");}
      } catch (error) {
        if (ctx.signal.aborted) return;
        ctx.log.error("koutu_failed");
        await ctx.telegram.edit(i.message, error instanceof UserError ? error.message : "抠图失败，请确认图片格式、尺寸及服务器日志");
      } finally {busy = false;}
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "koutu", description: "PicUP 图片与头像一键抠图",
    commands: {koutu: command}, renderHelp: prefix => renderCommandHelp("koutu", command, {prefix}),
    resources: {processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 30_000, maxOutputBytes: 65536}},
    settings: ctx => ({title: "一键抠图", description: "PicUP 服务配置", category: "插件配置", icon: "✂️",
      getSchema: () => [{key: "apiKey", label: "API Key", type: "password", secret: true}],
      getValues: () => store(ctx).read(),
      async setValues(patch) {const apiKey = patch.apiKey; if (typeof apiKey === "string") await store(ctx).update(value => ({...value, apiKey: apiKey.trim()}));},
    }),
  });
}
