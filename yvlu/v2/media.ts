import type {PluginContext} from "telebox/sdk";
import {native, UserError} from "./runtime";

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 16_777_216;

export function imageExt(buffer: Buffer): "webp" | "png" | "webm" {
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (buffer.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return "webm";
  throw new UserError("quote-api 返回了非图片/视频数据");
}

export async function downloadMediaBuffer(ctx: PluginContext, target: any): Promise<Buffer> {
  return ctx.files.withTemp(async (directory, signal) => {
    const {readFile, stat} = await import("node:fs/promises");
    const {join} = await import("node:path");
    const declared = target?.document?.size ?? target?.media?.document?.size;
    if (declared !== undefined && BigInt(String(declared)) > BigInt(MAX_MEDIA_BYTES)) throw new UserError("媒体超过 20 MiB");
    signal.throwIfAborted();
    const output = join(directory, "media");
    const result = await native(ctx, client => client.downloadMedia(target, {outputFile: output, signal,
      progressCallback: (received: any) => {
        signal.throwIfAborted();
        if (BigInt(String(received)) > BigInt(MAX_MEDIA_BYTES)) throw new UserError("媒体超过 20 MiB");
      }}));
    signal.throwIfAborted();
    if (!Buffer.isBuffer(result)) {
      const info = await stat(output);
      if (!info.isFile() || info.size > MAX_MEDIA_BYTES) throw new UserError("媒体超过 20 MiB");
    }
    const buffer = Buffer.isBuffer(result) ? result : await readFile(output);
    if (!buffer.length) throw new UserError("下载的媒体为空");
    if (buffer.length > MAX_MEDIA_BYTES) throw new UserError("媒体超过 20 MiB");
    return buffer;
  });
}

async function executable(ctx: PluginContext, name: string): Promise<string> {
  const {access, constants} = await import("node:fs/promises");
  const {join, isAbsolute, delimiter} = await import("node:path");
  for (const dir of (process.env.PATH || "").split(delimiter).filter(isAbsolute)) {
    ctx.signal.throwIfAborted();
    const file = join(dir, name);
    try { await access(file, constants.X_OK); return file; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code)))) throw error;
    }
  }
  throw new UserError(`缺少 ${name}，请安装后重试`);
}

export async function convertVideo(ctx: PluginContext, buffer: Buffer, tgs: boolean): Promise<Buffer> {
  return ctx.files.withTemp(async (directory, signal) => {
    const {writeFile, readFile} = await import("node:fs/promises");
    const {join} = await import("node:path");
    const input = join(directory, tgs ? "input.tgs" : "input.video");
    const gif = join(directory, "input.gif"), output = join(directory, "output.webm");
    const ffmpeg = await executable(ctx, "ffmpeg");
    signal.throwIfAborted();
    await writeFile(input, buffer, {signal});
    if (tgs) {
      const python = await executable(ctx, "python3");
      try {
        await ctx.processes.run(python, ["-c", "import sys\nfrom rlottie_python import LottieAnimation\nLottieAnimation.from_tgs(sys.argv[1]).save_animation(sys.argv[2])", input, gif],
          {signal, cwd: directory, env: {PATH: process.env.PATH, HOME: process.env.HOME}});
      } catch {
        signal.throwIfAborted();
        throw new UserError("TGS 转换失败，请检查 python3 的 rlottie-python、Pillow 依赖和贴纸数据");
      }
    }
    await ctx.processes.run(ffmpeg, ["-nostdin", "-v", "error", "-i", tgs ? gif : input,
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "400k", "-auto-alt-ref", "0", "-an", "-y", output],
    {signal, cwd: directory, env: {PATH: process.env.PATH}});
    signal.throwIfAborted();
    return readFile(output);
  });
}

export async function mediaData(ctx: PluginContext, message: any): Promise<{url: string} | undefined> {
  const media = message.media;
  if (!media?.photo && !media?.document) return undefined;
  let buffer = await downloadMediaBuffer(ctx, message);
  let mime: string = media.document?.mimeType || "image/jpeg";
  const tgs = mime === "application/x-tgsticker" || (buffer[0] === 31 && buffer[1] === 139);
  if (tgs || ["video/mp4", "image/gif"].includes(mime) || buffer.toString("ascii", 4, 8) === "ftyp") {
    buffer = await convertVideo(ctx, buffer, tgs);
    mime = "video/webm";
  }
  return {url: `data:${mime};base64,${buffer.toString("base64")}`};
}

export async function avatar(ctx: PluginContext, entity: any): Promise<{url: string} | undefined> {
  if (!entity.photo || /PhotoEmpty/.test(entity.photo.className || "")) return undefined;
  const {Api} = await import("teleproto");
  const {returnBigInt} = await import("teleproto/Helpers.js");
  const peer = await native(ctx, client => client.getInputEntity(entity));
  let buffer: Buffer | undefined;
  for (const big of [false, true]) {
    try {
      const result: any = await native(ctx, client => client.invoke(new Api.upload.GetFile({
        location: new Api.InputPeerPhotoFileLocation({peer: peer as any, photoId: entity.photo.photoId, big}),
        offset: returnBigInt(0), limit: 512 * 1024, precise: true,
      }), entity.photo.dcId));
      if (Buffer.isBuffer(result?.bytes) && result.bytes.length) { buffer = result.bytes; break; }
    } catch { ctx.signal.throwIfAborted(); ctx.log.info("yvlu.avatar.download.failed", {big}); }
  }
  if (!buffer) return undefined;
  const sharp = (await import("sharp")).default;
  ctx.signal.throwIfAborted();
  const png = await sharp(buffer, {limitInputPixels: MAX_INPUT_PIXELS}).resize(256, 256, {fit: "cover", position: "centre"})
    .flatten({background: "#000000"}).png().toBuffer();
  ctx.signal.throwIfAborted();
  return {url: `data:image/png;base64,${png.toString("base64")}`};
}

export async function generateQuote(ctx: PluginContext, data: unknown): Promise<{buffer: Buffer; ext: "webp" | "png" | "webm"}> {
  const result = await ctx.http.withResponse("https://quote-api-enhanced.zhetengsha.eu.org/generate.webp", {
    method: "POST", redirect: "error", headers: {"Content-Type": "application/json", "User-Agent": "TeleBox/0.2.1"},
    body: JSON.stringify(data),
  }, async (response, signal) => {
    const type = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (!response.ok || !/^(image\/|video\/|application\/octet-stream$)/.test(type)) {
      return {status: response.status, valid: false, buffer: Buffer.alloc(0)};
    }
    if (!response.body) return {status: response.status, valid: true, buffer: Buffer.alloc(0)};
    const reader = response.body.getReader();
    const parts: Buffer[] = [];
    let total = 0, done = false, cancellation: Promise<void> | undefined;
    const cancel = () => cancellation ??= reader.cancel();
    const abort = () => { void cancel().catch(() => undefined); };
    signal.addEventListener("abort", abort, {once: true});
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) { done = true; break; }
        total += chunk.value.byteLength;
        if (total > 20 * 1024 * 1024) throw new Error("Quote response exceeds limit");
        parts.push(Buffer.from(chunk.value));
      }
      return {status: response.status, valid: true, buffer: Buffer.concat(parts, total)};
    } finally {
      signal.removeEventListener("abort", abort);
      try { if (!done || cancellation) await cancel(); } finally { reader.releaseLock(); }
    }
  }, {timeoutMs: 60000});
  if (result.status < 200 || result.status >= 300) throw new UserError(`quote-api HTTP ${result.status}`);
  if (!result.valid) throw new UserError("quote-api 返回类型异常");
  return {buffer: result.buffer, ext: imageExt(result.buffer)};
}

export async function sendQuote(ctx: PluginContext, peer: any, replyTo: number, result: Awaited<ReturnType<typeof generateQuote>>): Promise<void> {
  const {Api} = await import("teleproto");
  const {CustomFile} = await import("teleproto/client/uploads.js");
  const attributes: any[] = [];
  if (result.ext !== "png") {
    attributes.push(new Api.DocumentAttributeSticker({alt: "📝", stickerset: new Api.InputStickerSetEmpty()}));
    if (result.ext === "webp") {
      const sharp = (await import("sharp")).default;
      const size = await sharp(result.buffer, {limitInputPixels: MAX_INPUT_PIXELS}).metadata();
      ctx.signal.throwIfAborted();
      attributes.push(new Api.DocumentAttributeImageSize({w: size.width || 512, h: size.height || 768}));
    }
    attributes.push(new Api.DocumentAttributeFilename({fileName: `quote.${result.ext}`}));
  }
  await native(ctx, client => client.sendFile(peer, {
    file: new CustomFile(`quote.${result.ext}`, result.buffer.length, "", result.buffer),
    attributes, forceDocument: false, replyTo,
  }));
}
