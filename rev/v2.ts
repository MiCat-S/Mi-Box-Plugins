import {renderHelp as renderPluginHelp} from "./v2/help";
import {open, stat} from "node:fs/promises";
import path from "node:path";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

type Flip = "h" | "v" | undefined;
const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
class DeliveredCleanupError extends Error {}
const aborted=(error:unknown):boolean=>error instanceof DOMException&&error.name==="AbortError";
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
  const args = ["-nostdin", "-y", "-protocol_whitelist", "file", "-i", input];
  if (gif) {
    const base = filters.join(",") || "null";
    args.push("-filter_complex", `[0:v]${base}[flip];[flip]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`, "-loop", "0");
  } else if (filters.length) args.push("-vf", filters.join(","));
  if (webm) args.push("-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "32", "-auto-alt-ref", "0");
  args.push("-fs", String(MAX_MEDIA_BYTES), output);
  return args;
}

async function runFfmpeg(context: PluginContext, args: readonly string[], directory:string,signal: AbortSignal): Promise<void> {
  for (const command of FFMPEG) {
    signal.throwIfAborted();
    try { await context.processes.run(command, args, {cwd:directory,signal, timeoutMs: 180_000, maxOutputBytes: 512 * 1024}); signal.throwIfAborted(); return; }
    catch (error) {
      signal.throwIfAborted();
      if ((error as {code?: unknown})?.code !== "SPAWN_FAILED") throw error;
      continue;
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
  await context.telegram.withClient(async (client, clientSignal) => {
    const signal=AbortSignal.any([context.signal,clientSignal]);
    const {Api} = await import("teleproto");
    signal.throwIfAborted();
    const peer=await client.getInputEntity(raw.peerId!);signal.throwIfAborted();
    await client.invoke(new Api.messages.EditMessage({peer,id:invocation.message.id,message:layout.text,entities}));
    signal.throwIfAborted();
  });
}

export default function createRev() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "rev", description: "反转文字或翻转回复的媒体",
    resources: {processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 180_000, maxOutputBytes: 512 * 1024}}, commands: {
    rev: {description: "反转文字或翻转回复的媒体", async handle(invocation, context) {
      const selected = parse(invocation.args);
      if (selected.text) { await context.telegram.edit(invocation.message, reverse(selected.text)); return; }
      const reply = invocation.message.replyToId === undefined ? undefined : await context.telegram.getReply(invocation.message);
      const info = mediaInfo(reply?.raw as ApiTypes.Message | undefined);
      if (!info && reply?.text) { await editReversedReply(context, invocation, reply); return; }
      if (!info) {
        await context.telegram.edit(invocation.message,renderPluginHelp(invocation.prefix),{parseMode:"html"});
        return;
      }
      let sent=false;
      try {
        await context.telegram.edit(invocation.message, "🔄 正在处理媒体，请稍候...",{parseMode:"html"});
        const source = reply!.raw as ApiTypes.Message;
        let operationSignal:AbortSignal|undefined;
        try{await context.files.withTemp(async (directory, signal) => {
          operationSignal=signal;
          const input = path.join(directory, `input${info.extension}`);
          const output = path.join(directory, `output${info.extension}`);
          if(Number(source.document?.size??0)>MAX_MEDIA_BYTES)throw new Error("Input too large");
          await context.telegram.withClient(async (client,clientSignal) => {const combined=AbortSignal.any([signal,clientSignal]),file=await open(input,"wx",0o600);let total=0;try{for await(const chunk of client.iterDownload(source.media! as any,{signal:combined})){combined.throwIfAborted();total+=chunk.length;if(total>MAX_MEDIA_BYTES)throw new Error("Input too large");let offset=0;while(offset<chunk.length){combined.throwIfAborted();const result=await file.write(chunk,offset,chunk.length-offset);combined.throwIfAborted();if(result.bytesWritten<=0)throw new Error("Write failed");offset+=result.bytesWritten;}}if(!total)throw new Error("Empty media");}finally{await file.close();}combined.throwIfAborted();});
          signal.throwIfAborted();
          await runFfmpeg(context, ffmpegArgs(input, output, selected.flip, selected.invert, info.gif, info.webm),directory,signal);
          const result = await stat(output);
          signal.throwIfAborted();
          if (!result.isFile() || !result.size || result.size > MAX_MEDIA_BYTES) throw new Error("Invalid output");
          await context.telegram.withClient(async (client,clientSignal) => {
            const combined=AbortSignal.any([signal,clientSignal]);combined.throwIfAborted();
            const raw = invocation.message.raw as ApiTypes.Message | undefined;
            if (!raw?.peerId) throw new Error("Missing peer");
            const options: any = {file: output, replyTo: invocation.message.replyToId,topMsgId:invocation.message.topicId};
            if (reply?.text) {
              const layout = reverseLayout(reply.text);
              options.caption = layout.text;
              const entities = reversedEntities(layout, reply.text, ((source as any).entities ?? []));
              if (entities.length) options.formattingEntities = entities;
            }
            if (info.webm || info.webp) {
              const {Api} = await import("teleproto");
              combined.throwIfAborted();
              options.attributes = [new Api.DocumentAttributeSticker({alt: "rev", stickerset: new Api.InputStickerSetEmpty()})];
            }
            combined.throwIfAborted();
            await client.sendFile(raw.peerId, options);
            sent=true;combined.throwIfAborted();
          });
        });}catch(error){context.signal.throwIfAborted();operationSignal?.throwIfAborted();if(aborted(error))throw error;if(sent){context.log.error("rev_temp_cleanup_failed");}else throw error;}
        const raw=invocation.message.raw as ApiTypes.Message|undefined;
        if(typeof raw?.delete==="function"){context.signal.throwIfAborted();try{await raw.delete({revoke:true});context.signal.throwIfAborted();return;}catch{context.signal.throwIfAborted();context.log.error("rev_command_cleanup_failed");}}
        try{await context.telegram.edit(invocation.message,"✅ 媒体已处理完成");}catch{context.signal.throwIfAborted();context.log.error("rev_receipt_failed");}
      } catch(error) {
        if (context.signal.aborted) return;
        if(aborted(error))return;
        if(sent){context.log.error("rev_receipt_failed");return;}
        context.log.error("rev_failed");
        await context.telegram.edit(invocation.message, "媒体处理失败，请确认服务器已安装 FFmpeg 且媒体格式受支持");
      }
    },helpArgs:["help","h"]},
  }});
}
