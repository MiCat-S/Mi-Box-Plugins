import {access, open, stat} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

type Flip = "h" | "v" | undefined;
const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const MAX_INPUT_BYTES = 100 * 1024 * 1024;
async function writeAll(file:Awaited<ReturnType<typeof open>>,chunk:Uint8Array){let offset=0;while(offset<chunk.length){const result=await file.write(chunk,offset,chunk.length-offset);if(result.bytesWritten<=0)throw new Error("Input write failed");offset+=result.bytesWritten;}}
const segmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"});
const FORMAT_ENTITIES = new Set(["MessageEntityBold", "MessageEntityItalic", "MessageEntityUnderline",
  "MessageEntityStrike", "MessageEntitySpoiler"]);
const CODE_ENTITIES = new Set(["MessageEntityCode", "MessageEntityPre"]);

type TextUnit = {sourceStart: number; sourceEnd: number; outputStart: number; outputEnd: number; text: string};
type TextLayout = {text: string; units: TextUnit[]};
type EntityRange = {entity: any; offset: number; length: number; sourceIndex: number; pieceIndex: number;
  format: boolean; code: boolean};

function reverseLayout(text: string): TextLayout {
  const units: TextUnit[] = [];
  const output: string[] = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    const lineFeed = text.indexOf("\n", lineStart);
    const hasLineFeed = lineFeed >= 0;
    const lineEnd = hasLineFeed ? lineFeed > lineStart && text[lineFeed - 1] === "\r" ? lineFeed - 1 : lineFeed : text.length;
    const line = text.slice(lineStart, lineEnd);
    const graphemes = [...segmenter.segment(line)];
    output.push(graphemes.map(value => value.segment).reverse().join(""));
    for (const value of graphemes) {
      const sourceStart = lineStart + value.index;
      units.push({sourceStart, sourceEnd: sourceStart + value.segment.length,
        outputStart: lineStart + line.length - value.index - value.segment.length,
        outputEnd: lineStart + line.length - value.index, text: value.segment});
    }
    if (!hasLineFeed) break;
    const newlineEnd = lineFeed + 1;
    const newline = text.slice(lineEnd, newlineEnd);
    units.push({sourceStart: lineEnd, sourceEnd: newlineEnd, outputStart: lineEnd, outputEnd: newlineEnd, text: newline});
    output.push(newline);
    lineStart = newlineEnd;
  }
  return {text: output.join(""), units};
}

function reverse(text: string): string {
  return reverseLayout(text).text;
}

function entityName(entity: any): string {
  return typeof entity?.className === "string" ? entity.className : String(entity?.constructor?.name ?? "");
}

function conflicts(left: EntityRange, right: EntityRange): boolean {
  const leftEnd = left.offset + left.length;
  const rightEnd = right.offset + right.length;
  if (left.offset >= rightEnd || right.offset >= leftEnd) return false;
  const nested = left.offset <= right.offset && leftEnd >= rightEnd
    || right.offset <= left.offset && rightEnd >= leftEnd;
  if (!nested || left.code || right.code) return true;
  return !left.format && !right.format;
}

function reversedEntities(layout: TextLayout, sourceText: string, entities: readonly any[]): any[] {
  const accepted: EntityRange[] = [];
  const outputUnitByEnd = new Map(layout.units.map(unit => [unit.outputEnd, unit]));
  entities.forEach((entity, sourceIndex) => {
    const offset = Number(entity?.offset); const length = Number(entity?.length);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0
      || offset > sourceText.length || length > sourceText.length - offset) return;
    const end = offset + length;
    const name = entityName(entity);
    const format = FORMAT_ENTITIES.has(name);
    const code = CODE_ENTITIES.has(name);
    const ranges = layout.units.filter(value => format
      ? value.sourceStart < end && value.sourceEnd > offset
      : value.sourceStart >= offset && value.sourceEnd <= end)
      .map(value => ({start: value.outputStart, end: value.outputEnd})).sort((a, b) => a.start - b.start);
    const merged: Array<{start: number; end: number}> = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({...range});
    }
    const candidates = merged.flatMap((range, pieceIndex): EntityRange[] => {
      let rangeEnd = range.end;
      for (let tail = outputUnitByEnd.get(rangeEnd); tail && tail.outputStart >= range.start && tail.text.trim().length === 0;
        tail = outputUnitByEnd.get(rangeEnd)) rangeEnd = tail.outputStart;
      if (rangeEnd <= range.start) return [];
      return [{entity: Object.assign(Object.create(Object.getPrototypeOf(entity)), entity,
        {offset: range.start, length: rangeEnd - range.start}), offset: range.start, length: rangeEnd - range.start,
      sourceIndex, pieceIndex, format, code}];
    });
    if (candidates.some(candidate => accepted.some(previous => conflicts(candidate, previous)))) return;
    accepted.push(...candidates);
  });
  return accepted.sort((left, right) => left.offset - right.offset || right.length - left.length
    || left.sourceIndex - right.sourceIndex || left.pieceIndex - right.pieceIndex).map(value => value.entity);
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
  args.push("-fs", String(50 * 1024 * 1024), output);
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
  const layout = reverseLayout(text);
  const entities = reversedEntities(layout, text, (source as any)?.entities ?? []);
  if (!entities.length || !raw?.peerId) { await context.telegram.edit(invocation.message, layout.text); return; }
  await context.telegram.withClient(async client => {
    const {Api} = await import("teleproto");
    await client.invoke(new Api.messages.EditMessage({peer: await client.getInputEntity(raw.peerId!), id: invocation.message.id,
      message: layout.text, entities}));
  });
}

export default function createRev() {
  const command: CommandDefinition = {"args":"[h|v] [c] [文字]","arguments":[{"name":"h / v","description":"媒体水平翻转（h，默认）或垂直翻转（v），多个方向以最后一个为准"},{"name":"c","description":"颜色反转；单独使用只反色，可与方向组合"}],"examples":[{"args":"你好世界","description":"得到“界世好你”，支持 emoji"},{"args":"","description":"回复文字反转内容；回复媒体默认水平翻转"},{"args":"v","description":"回复图片上下翻转"},{"args":"c","description":"回复 GIF 反色"},{"args":"h c","description":"回复 WebM 水平翻转并反色"}],"help":[{"heading":"支持与依赖：","body":"文字按行反转并保留 emoji 组合；回复文字尽量保留格式实体。媒体支持图片、GIF、WebM、WebP，需要服务器已安装 FFmpeg，输入最多 100 MiB、输出最多 50 MiB。"}],helpArgs:["help"],description: "反转文字或翻转回复的媒体", async handle(invocation, context) {
      const selected = parse(invocation.args);
      if (selected.text) { await context.telegram.edit(invocation.message, reverse(selected.text)); return; }
      const reply = invocation.message.replyToId === undefined ? undefined : await context.telegram.getReply(invocation.message);
      const info = mediaInfo(reply?.raw as ApiTypes.Message | undefined);
      if (!info && reply?.text) { await editReversedReply(context, invocation, reply); return; }
      if (!info) {
        await context.telegram.edit(invocation.message,
          help(invocation.prefix), {parseMode: "html"});
        return;
      }
      try {
        await context.telegram.edit(invocation.message, "正在处理媒体…");
        const source = reply!.raw as ApiTypes.Message;
        if (Number(source.document?.size ?? 0) > MAX_INPUT_BYTES) throw new Error("Input too large");
        await context.files.withTemp(async (directory, signal) => {
          const input = path.join(directory, `input${info.extension}`);
          const output = path.join(directory, `output${info.extension}`);
          await context.telegram.withClient(async (client: any) => {
            if (typeof client.iterDownload !== "function") {
              await client.downloadMedia(source.media!, {outputFile: input, signal, progressCallback(received: any) {
                signal.throwIfAborted(); if (typeof received?.greater === "function" && received.greater(MAX_INPUT_BYTES)) throw new Error("Input too large");
              }});
              const info = await stat(input);
              if (!info.isFile() || !info.size || info.size > MAX_INPUT_BYTES) throw new Error("Input too large");
              return;
            }
            const file = await open(input, "wx", 0o600);
            let total = 0;
            try {
              for await (const chunk of client.iterDownload(source.media!, {})) {
                signal.throwIfAborted(); total += chunk.length;
                if (total > MAX_INPUT_BYTES) throw new Error("Input too large");
                await writeAll(file,chunk);
              }
              if (!total) throw new Error("Empty input");
            } finally { await file.close(); }
          });
          signal.throwIfAborted();
          await runFfmpeg(context, ffmpegArgs(input, output, selected.flip, selected.invert, info.gif, info.webm));
          const result = await stat(output);
          if (!result.isFile() || !result.size || result.size > 50 * 1024 * 1024) throw new Error("Invalid output");
          await context.telegram.withClient(async client => {
            const raw = invocation.message.raw as ApiTypes.Message | undefined;
            if (!raw?.peerId) throw new Error("Missing peer");
            const options: any = {file: output, replyTo: invocation.message.replyToId};
            if (reply?.text) {
              const layout = reverseLayout(reply.text);
              options.caption = layout.text;
              const entities = reversedEntities(layout, reply.text, ((source as any).entities ?? []));
              if (entities.length) options.entities = entities;
            }
            if (info.webm || info.webp) {
              const {Api} = await import("teleproto");
              options.attributes = [new Api.DocumentAttributeSticker({alt: "rev", stickerset: new Api.InputStickerSetEmpty()})];
            }
            await client.sendFile(raw.peerId, options);
            if (typeof raw.delete === "function") {
              try { await raw.delete({revoke: true}); }
              catch { context.log.error("rev_command_cleanup_failed"); }
            }
          });
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("rev_failed");
        await context.telegram.edit(invocation.message, "媒体处理失败，请确认服务器已安装 FFmpeg 且媒体格式受支持");
      }
    }};
  const help = (prefix: string) => renderCommandHelp("rev", command, {prefix, title: "🔄 内容反转"});
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "rev", description: "反转文字或翻转回复的媒体",
    resources: {processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 180_000, maxOutputBytes: 512 * 1024}}, commands: {
    rev: command,
  }});
}
