import {access, stat} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

type Flip = "h" | "v" | undefined;
const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const segmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"});

function reverse(text: string): string {
  return text.split("\n").map(line => [...segmenter.segment(line)].map(value => value.segment).reverse().join("")).join("\n");
}

function reversedEntities(text: string, entities: readonly any[]): any[] {
  const lineStarts: number[] = [];
  let start = 0;
  for (const line of text.split("\n")) { lineStarts.push(start); start += line.length + 1; }
  return entities.flatMap(entity => {
    const offset = Number(entity?.offset); const length = Number(entity?.length);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > text.length) return [];
    const lineStart = [...lineStarts].reverse().find(value => value <= offset) ?? 0;
    const lineEnd = text.indexOf("\n", lineStart); const limit = lineEnd < 0 ? text.length : lineEnd;
    if (offset + length > limit) return [];
    const clone = Object.assign(Object.create(Object.getPrototypeOf(entity)), entity);
    clone.offset = lineStart + (limit - lineStart) - (offset - lineStart) - length;
    return [clone];
  });
}

function parse(args: readonly string[]): {flip: Flip; invert: boolean; text: string} {
  let flip: Flip;
  let invert = false;
  let index = 0;
  while (index < args.length) {
    const value = args[index]!.toLowerCase();
    if (value === "h" || value === "v") { flip = value; index++; continue; }
    if (value === "c") { invert = true; index++; continue; }
    break;
  }
  if (!flip && !(invert && index === args.length && args.length)) flip = "h";
  return {flip, invert, text: args.slice(index).join(" ").trim()};
}

function mediaInfo(raw: ApiTypes.Message | undefined): {extension: string; gif: boolean; webm: boolean; webp: boolean} | undefined {
  if (!raw?.media) return;
  const document: any = raw.document;
  if (!document && raw.photo) return {extension: ".jpg", gif: false, webm: false, webp: false};
  const mime = String(document?.mimeType ?? "").toLowerCase();
  const filename = (document?.attributes ?? []).map((value: any) => value?.fileName).find((value: any) => typeof value === "string") ?? "";
  if (filename.toLowerCase().endsWith(".gif.mp4")) return {extension: ".gif", gif: true, webm: false, webp: false};
  if (mime === "image/gif") return {extension: ".gif", gif: true, webm: false, webp: false};
  if (mime.includes("webm")) return {extension: ".webm", gif: false, webm: true, webp: false};
  if (mime === "image/webp") return {extension: ".webp", gif: false, webm: false, webp: true};
  if (mime === "image/png") return {extension: ".png", gif: false, webm: false, webp: false};
  if (mime === "image/bmp") return {extension: ".bmp", gif: false, webm: false, webp: false};
  if (mime === "image/jpeg" || mime === "image/jpg") return {extension: ".jpg", gif: false, webm: false, webp: false};
}

function ffmpegArgs(input: string, output: string, flip: Flip, invert: boolean, gif: boolean, webm: boolean): string[] {
  const filters = [flip === "h" ? "hflip" : flip === "v" ? "vflip" : "", invert ? "negate" : ""].filter(Boolean);
  const args = ["-nostdin", "-y", "-i", input];
  if (gif) {
    const base = filters.join(",") || "null";
    args.push("-filter_complex", `[0:v]${base}[flip];[flip]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`, "-loop", "0");
  } else if (filters.length) args.push("-vf", filters.join(","));
  if (webm) args.push("-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "32", "-auto-alt-ref", "0");
  args.push(output);
  return args;
}

async function runFfmpeg(context: PluginContext, args: readonly string[]): Promise<void> {
  for (const command of FFMPEG) {
    try { await context.processes.run(command, args, {timeoutMs: 180_000, maxOutputBytes: 512 * 1024}); return; }
    catch (error) {
      context.signal.throwIfAborted();
      if ((error as {code?: unknown})?.code !== "SPAWN_FAILED") throw error;
      try { await access(command, constants.F_OK); } catch { continue; }
      throw error;
    }
  }
  throw new Error("FFmpeg unavailable");
}

async function editReversedReply(context: PluginContext, invocation: any, reply: any): Promise<void> {
  const raw = invocation.message.raw as ApiTypes.Message | undefined;
  const source = reply.raw as ApiTypes.Message | undefined;
  const text = reply.text as string;
  const entities = reversedEntities(text, (source as any)?.entities ?? []);
  if (!entities.length || !raw?.peerId) { await context.telegram.edit(invocation.message, reverse(text)); return; }
  await context.telegram.withClient(async client => {
    const {Api} = await import("teleproto");
    await client.invoke(new Api.messages.EditMessage({peer: await client.getInputEntity(raw.peerId!), id: invocation.message.id,
      message: reverse(text), entities}));
  });
}

export default function createRev() {
  return definePlugin({apiVersion: 1, id: "rev", description: "反转文字或翻转回复的媒体",
    resources: {processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 180_000, maxOutputBytes: 512 * 1024}}, commands: {
    rev: {description: "反转文字或翻转回复的媒体", async handle(invocation, context) {
      const selected = parse(invocation.args);
      if (selected.text) { await context.telegram.edit(invocation.message, reverse(selected.text)); return; }
      const reply = invocation.message.replyToId === undefined ? undefined : await context.telegram.getReply(invocation.message);
      const info = mediaInfo(reply?.raw as ApiTypes.Message | undefined);
      if (!info && reply?.text) { await editReversedReply(context, invocation, reply); return; }
      if (!info) {
        await context.telegram.edit(invocation.message,
          `<b>内容反转</b>\n<code>${invocation.prefix}rev 文字</code>\n回复媒体可使用 <code>${invocation.prefix}rev [h|v] [c]</code>。`, {parseMode: "html"});
        return;
      }
      try {
        await context.telegram.edit(invocation.message, "正在处理媒体…");
        const source = reply!.raw as ApiTypes.Message;
        await context.files.withTemp(async (directory, signal) => {
          const input = path.join(directory, `input${info.extension}`);
          const output = path.join(directory, `output${info.extension}`);
          await context.telegram.withClient(async client => { await client.downloadMedia(source.media!, {outputFile: input}); });
          signal.throwIfAborted();
          await runFfmpeg(context, ffmpegArgs(input, output, selected.flip, selected.invert, info.gif, info.webm));
          const result = await stat(output);
          if (!result.isFile() || !result.size || result.size > 50 * 1024 * 1024) throw new Error("Invalid output");
          await context.telegram.withClient(async client => {
            const raw = invocation.message.raw as ApiTypes.Message | undefined;
            if (!raw?.peerId) throw new Error("Missing peer");
            const options: any = {file: output, replyTo: invocation.message.replyToId};
            if (reply?.text) {
              options.caption = reverse(reply.text);
              const entities = reversedEntities(reply.text, ((source as any).entities ?? []));
              if (entities.length) options.entities = entities;
            }
            if (info.webm || info.webp) {
              const {Api} = await import("teleproto");
              options.attributes = [new Api.DocumentAttributeSticker({alt: "rev", stickerset: new Api.InputStickerSetEmpty()})];
            }
            await client.sendFile(raw.peerId, options);
            if (typeof raw.delete === "function") await raw.delete({revoke: true});
          });
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("rev_failed");
        await context.telegram.edit(invocation.message, "媒体处理失败，请确认服务器已安装 FFmpeg 且媒体格式受支持");
      }
    }},
  }});
}
