import {readFile, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import type {MessageEnvelope, PluginContext} from "telebox/sdk";
import {returnBigInt} from "teleproto/Helpers";

const MAX_ITEM_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 24 * 1024;
const MAX_PIXELS = 20_000_000;
const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;

type Options = {replies: boolean; media: boolean; crop: boolean; scale: number; hidden: boolean;
  format?: "webp" | "png" | "story"; imagePreview?: boolean};
type Source = {raw: any; envelope?: MessageEnvelope};
type Budget = {media: number; text: number};

class QuoteBudgetError extends Error {}

function decimalId(value: any): string {
  const raw = value?.userId ?? value?.chatId ?? value?.channelId ?? value?.id ?? value;
  if (raw === undefined || raw === null) return "0";
  try { return returnBigInt(String(raw)).toString(); }
  catch { return "0"; }
}

function displayName(entity: any, fallback?: unknown): string {
  return [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") || entity?.title ||
    (entity?.username ? `@${entity.username}` : "") || String(fallback ?? `ID ${decimalId(entity)}`);
}

const documentOf = (raw: any) => raw?.document ?? raw?.media?.document;
const attributes = (raw: any): any[] => documentOf(raw)?.attributes ?? [];
const attribute = (raw: any, name: string) => attributes(raw).find(value =>
  String(value?.className ?? value?.constructor?.name ?? "").includes(name));

function mediaKind(raw: any): string | undefined {
  if (!raw?.media) return undefined;
  const className = String(raw.media.className ?? raw.media.constructor?.name ?? "");
  if (attribute(raw, "Sticker")) return "sticker";
  if (attribute(raw, "Animated") || className.includes("Dice")) return "animation";
  const audio = attribute(raw, "Audio");
  if (audio?.voice) return "voice";
  if (audio) return "audio";
  const video = attribute(raw, "Video");
  if (video?.roundMessage) return "round";
  if (video) return "video";
  if (className.includes("Photo")) return "photo";
  if (className.includes("Geo")) return "location";
  if (className.includes("Venue")) return "venue";
  if (className.includes("Contact")) return "contact";
  if (className.includes("Poll")) return "poll";
  if (className.includes("Document")) return "document";
  return "media";
}

function mediaFallback(kind?: string): string {
  return ({video:"[视频]", round:"[圆形视频]", voice:"[语音]", audio:"[音频]", location:"[位置]", venue:"[地点]",
    contact:"[联系人]", poll:"[投票]", media:"[媒体]"} as Record<string, string>)[kind ?? ""] ?? "";
}

function convertEntities(raw: any): Record<string, any>[] {
  const entities = [...(raw?.entities ?? []), ...(raw?.captionEntities ?? raw?.caption_entities ?? [])];
  return entities.map((entity: any) => {
    const className = String(entity?.className ?? entity?.constructor?.name ?? "");
    const offset = Number(entity?.offset);
    const length = Number(entity?.length);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) return undefined;
    const mappings: [string, string][] = [["CustomEmoji","custom_emoji"], ["Blockquote","blockquote"],
      ["MentionName","text_mention"], ["TextUrl","text_link"], ["BotCommand","bot_command"],
      ["Underline","underline"], ["Strike","strikethrough"], ["Spoiler","spoiler"],
      ["Hashtag","hashtag"], ["Cashtag","cashtag"], ["Phone","phone_number"], ["Email","email"],
      ["Italic","italic"], ["Bold","bold"], ["Pre","pre"], ["Code","code"], ["Mention","mention"], ["Url","url"]];
    const type = mappings.find(([part]) => className.includes(part))?.[1];
    if (!type) return undefined;
    return {type, offset, length,
      ...(type === "custom_emoji" ? {custom_emoji_id: decimalId(entity.documentId ?? entity.document_id)} : {}),
      ...(type === "text_link" ? {url: String(entity.url ?? "")} : {}),
      ...(type === "text_mention" ? {user: decimalId(entity.userId ?? entity.user_id)} : {}),
      ...(type === "pre" && entity.language ? {language: String(entity.language)} : {})};
  }).filter(Boolean) as Record<string, any>[];
}

function waveform(raw: unknown): number[] {
  const values = Array.isArray(raw) || raw instanceof Uint8Array ? raw : [];
  return Array.from(values).map(value => Math.max(0, Math.min(31, Number(value) || 0)));
}

function isVisual(kind?: string): boolean {
  return kind === "photo" || kind === "sticker" || kind === "animation" || kind === "video" || kind === "round";
}

async function staticThumbnail(raw: any, signal: AbortSignal): Promise<any | undefined> {
  const document = documentOf(raw);
  const values = [...(document?.videoThumbs ?? document?.video_thumbs ?? []), ...(document?.thumbs ?? [])];
  const thumbnail = values.reverse().find(value => value?.type && !String(value.className ?? "").includes("Empty"));
  if (!thumbnail || document?.id === undefined || document?.accessHash === undefined) return undefined;
  const {Api} = await import("teleproto");
  signal.throwIfAborted();
  const location = new Api.InputDocumentFileLocation({id:returnBigInt(decimalId(document.id)),
    accessHash:returnBigInt(decimalId(document.accessHash)), fileReference:document.fileReference ?? document.file_reference ?? Buffer.alloc(0),
    thumbSize:String(thumbnail.type)});
  return {location, dcId:document.dcId ?? document.dc_id};
}

function isRaster(buffer: Buffer): boolean {
  return buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
    (buffer[0] === 0xff && buffer[1] === 0xd8) || buffer.subarray(0, 4).toString("ascii") === "GIF8" ||
    (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP");
}

function isVideo(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) ||
    buffer.subarray(4, 8).toString("ascii") === "ftyp";
}

async function download(client: any, signal: AbortSignal, target: any, budget: Budget, limit = MAX_ITEM_BYTES): Promise<Buffer | undefined> {
  const declared = Number(target?.document?.size ?? target?.size ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw new QuoteBudgetError("QUOTE_MEDIA_LIMIT");
  let size = 0;
  const chunks: Buffer[] = [];
  const location = target?.location ?? target;
  const options = {signal, ...(target?.dcId === undefined ? {} : {dcId:target.dcId})};
  for await (const chunk of client.iterDownload(location, options)) {
    signal.throwIfAborted();
    const value = Buffer.from(chunk);
    size += value.length;
    budget.media += value.length;
    if (size > limit || budget.media > MAX_TOTAL_BYTES) throw new QuoteBudgetError("QUOTE_MEDIA_LIMIT");
    chunks.push(value);
  }
  signal.throwIfAborted();
  return size ? Buffer.concat(chunks, size) : undefined;
}

async function rasterPng(buffer: Buffer, signal: AbortSignal, width: number, height: number, crop: boolean): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  signal.throwIfAborted();
  const result = await sharp(buffer, {animated:false, pages:1, limitInputPixels:MAX_PIXELS}).rotate()
    .resize({width, height, fit:crop ? "cover" : "inside", withoutEnlargement:!crop}).png().toBuffer();
  signal.throwIfAborted();
  return result;
}

async function mediaPng(buffer: Buffer, signal: AbortSignal): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  signal.throwIfAborted();
  const result = await sharp(buffer, {animated:false, pages:1, limitInputPixels:MAX_PIXELS}).png().toBuffer();
  signal.throwIfAborted();
  return result;
}

async function canvasFromPng(png: Buffer, signal: AbortSignal): Promise<any> {
  const canvas = require("../vendor/canvas");
  return canvas.withCanvasBudget(signal, async () => {
    const image = await canvas.loadImage(png);
    const output = canvas.createCanvas(image.width, image.height);
    output.getContext("2d").drawImage(image, 0, 0);
    return output;
  });
}

async function videoPng(context: PluginContext, buffer: Buffer, signal: AbortSignal): Promise<Buffer> {
  return context.files.withTemp(async (directory, tempSignal) => {
    const active = AbortSignal.any([signal, tempSignal]);
    const input = path.join(directory, "input.bin");
    const output = path.join(directory, "frame.png");
    await writeFile(input, buffer, {mode:0o600, signal:active});
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-i", input,
      "-frames:v", "1", "-vf", "scale=584:240:force_original_aspect_ratio=decrease", "-fs", String(MAX_ITEM_BYTES), output];
    let complete = false;
    for (const executable of FFMPEG) {
      try {
        await context.processes.run(executable, args, {cwd:directory, env:{}, signal:active, timeoutMs:15000, maxOutputBytes:64*1024});
        complete = true;
        break;
      } catch (error: any) {
        active.throwIfAborted();
        if (error?.code !== "SPAWN_FAILED") throw error;
      }
    }
    if (!complete) throw new Error("QUOTE_FFMPEG_MISSING");
    active.throwIfAborted();
    const info = await stat(output);
    active.throwIfAborted();
    if (!info.isFile() || info.size <= 0 || info.size > MAX_ITEM_BYTES) throw new QuoteBudgetError("QUOTE_MEDIA_LIMIT");
    const png = await readFile(output, {signal:active});
    active.throwIfAborted();
    return png;
  });
}

async function avatarBuffer(client: any, signal: AbortSignal, entity: any, budget: Budget): Promise<Buffer | undefined> {
  if (!entity || typeof client.downloadProfilePhoto !== "function") return undefined;
  try {
    const value = await client.downloadProfilePhoto(entity, {isBig:false, signal});
    signal.throwIfAborted();
    if (!Buffer.isBuffer(value) || !value.length || value.length > 2 * 1024 * 1024) return undefined;
    budget.media += value.length;
    if (budget.media > MAX_TOTAL_BYTES) throw new QuoteBudgetError("QUOTE_MEDIA_LIMIT");
    return await rasterPng(value, signal, 128, 128, true);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof QuoteBudgetError) throw error;
    return undefined;
  }
}

async function senderEntity(client: any, signal: AbortSignal, raw: any): Promise<any> {
  if (raw?.sender) return raw.sender;
  if (typeof raw?.getSender === "function") try {
    const value = await raw.getSender();
    signal.throwIfAborted();
    if (value) return value;
  } catch { signal.throwIfAborted(); }
  if (raw?.senderId !== undefined && typeof client.getEntity === "function") try {
    const value = await client.getEntity(raw.senderId);
    signal.throwIfAborted();
    return value;
  } catch { signal.throwIfAborted(); }
}

async function forwardSource(client: any, signal: AbortSignal, raw: any): Promise<any> {
  const forward = raw?.fwdFrom ?? raw?.fwd_from;
  if (!forward) return undefined;
  const peer = forward.fromId ?? forward.from_id ?? forward.savedFromPeer ?? forward.saved_from_peer;
  const header = forward.fromName ?? forward.from_name ?? forward.postAuthor ?? forward.post_author;
  let entity;
  if (peer && typeof client.getEntity === "function") try {
    entity = await client.getEntity(peer);
    signal.throwIfAborted();
  } catch { signal.throwIfAborted(); }
  return {peer, entity, name:displayName(entity, header || "Forwarded"), anonymous:!entity};
}

function emojiStatus(entity: any): Record<string, any> | undefined {
  const value = entity?.emojiStatus?.documentId ?? entity?.emoji_status?.document_id ??
    (typeof entity?.emojiStatus !== "object" ? entity?.emojiStatus : undefined) ??
    (typeof entity?.emoji_status !== "object" ? entity?.emoji_status : undefined);
  return value ? {custom_emoji_id:decimalId(value)} : undefined;
}

async function senderRank(client: any, signal: AbortSignal, raw: any, entity: any): Promise<string | undefined> {
  if (!entity?.accessHash || !raw?.peerId) return undefined;
  try {
    const {Api} = await import("teleproto");
    signal.throwIfAborted();
    const result: any = await client.invoke(new Api.channels.GetParticipant({channel:raw.peerId,
      participant:new Api.InputUser({userId:returnBigInt(decimalId(entity)), accessHash:returnBigInt(decimalId(entity.accessHash))})}));
    signal.throwIfAborted();
    return result?.participant?.rank?.trim() || undefined;
  } catch { signal.throwIfAborted(); return undefined; }
}

function collectEmojiIds(messages: Record<string, any>[]): string[] {
  const ids = new Set<string>();
  const visit = (message: any) => {
    for (const entity of [...(message.entities ?? []), ...(message.caption_entities ?? [])])
      if (entity.type === "custom_emoji" && entity.custom_emoji_id !== "0") ids.add(String(entity.custom_emoji_id));
    const status = message.emoji_status ?? message.from?.emoji_status;
    if (status?.custom_emoji_id && status.custom_emoji_id !== "0") ids.add(String(status.custom_emoji_id));
    if (message.replyMessage) visit(message.replyMessage);
  };
  messages.forEach(visit);
  return [...ids];
}

async function hydrateEmoji(context: PluginContext, client: any, signal: AbortSignal, messages: Record<string, any>[], budget: Budget): Promise<void> {
  const ids = collectEmojiIds(messages);
  if (!ids.length) return;
  const {Api} = await import("teleproto");
  signal.throwIfAborted();
  let documents: any;
  try {
    documents = await client.invoke(new Api.messages.GetCustomEmojiDocuments({documentId:ids.map(returnBigInt)}));
    signal.throwIfAborted();
  } catch { signal.throwIfAborted(); return; }
  const buffers = new Map<string, Buffer>();
  for (const document of Array.isArray(documents) ? documents : []) {
    const value = await download(client, signal, document, budget, 512 * 1024);
    if (!value) continue;
    let normalized: Buffer | undefined;
    try {
      if (isRaster(value)) normalized = await mediaPng(value, signal);
      else if (isVideo(value)) normalized = await videoPng(context, value, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof QuoteBudgetError) throw error;
    }
    if (!normalized) {
      const thumbnail = await staticThumbnail({media:{document}}, signal);
      const thumbnailValue = thumbnail ? await download(client, signal, thumbnail, budget, 2 * 1024 * 1024) : undefined;
      if (thumbnailValue && isRaster(thumbnailValue)) normalized = await mediaPng(thumbnailValue, signal);
    }
    if (normalized) buffers.set(decimalId(document.id), normalized);
  }
  const visit = (message: any) => {
    for (const entity of [...(message.entities ?? []), ...(message.caption_entities ?? [])]) {
      const value = buffers.get(String(entity.custom_emoji_id ?? ""));
      if (value) entity.customEmojiBuffer = value;
    }
    for (const status of [message.emoji_status, message.from?.emoji_status]) {
      const value = buffers.get(String(status?.custom_emoji_id ?? ""));
      if (value) status.customEmojiBuffer = value;
    }
    if (message.replyMessage) visit(message.replyMessage);
  };
  messages.forEach(visit);
}

export async function toQuoteMessages(context: PluginContext, sources: Source[], options: Options): Promise<Record<string, any>[]> {
  const budget: Budget = {media:0, text:0};
  return context.telegram.withClient(async (client: any, signal) => {
    const convert = async (source: Source, includeReply: boolean): Promise<Record<string, any>> => {
      signal.throwIfAborted();
      const raw = source.raw;
      const current = await senderEntity(client, signal, raw);
      const forwarded = await forwardSource(client, signal, raw);
      const entity = forwarded?.entity ?? current;
      const senderName = forwarded?.name ?? displayName(entity, raw?.postAuthor);
      const kind = mediaKind(raw);
      let mediaBuffer: Buffer | undefined;
      let mediaCanvas: any;
      const mime = String(documentOf(raw)?.mimeType ?? documentOf(raw)?.mime_type ?? "").toLowerCase();
      if ((isVisual(kind) || (options.media || options.imagePreview || options.format === "png") && kind === "document" && mime.startsWith("image/")) && raw.media) {
        mediaBuffer = await download(client, signal, raw.media, budget);
        if (mediaBuffer) try {
          let png = isVideo(mediaBuffer) || (kind === "video" || kind === "round" || kind === "animation") && !isRaster(mediaBuffer)
            ? await videoPng(context, mediaBuffer, signal)
            : isRaster(mediaBuffer) ? await mediaPng(mediaBuffer, signal) : undefined;
          if (!png) {
            const thumbnail = await staticThumbnail(raw, signal);
            const thumbnailBuffer = thumbnail ? await download(client, signal, thumbnail, budget, 2 * 1024 * 1024) : undefined;
            if (thumbnailBuffer && isRaster(thumbnailBuffer)) png = await mediaPng(thumbnailBuffer, signal);
          }
          if (png) mediaCanvas = await canvasFromPng(png, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof QuoteBudgetError) throw error;
        }
      }
      const audioAttribute = attribute(raw, "Audio");
      const document = documentOf(raw);
      const entities = convertEntities(raw);
      let replyMessage;
      if (includeReply && options.replies) {
        const replyId = raw?.replyTo?.replyToMsgId ?? raw?.replyToMsgId;
        if (replyId && raw?.peerId) {
          const replies = await client.getMessages(raw.peerId, {ids:[replyId]});
          signal.throwIfAborted();
          if (replies?.[0]) replyMessage = await convert({raw:replies[0]}, false);
        }
      }
      const avatar = options.hidden ? undefined : await avatarBuffer(client, signal, entity, budget);
      const wave = waveform(audioAttribute?.waveform);
      const voice = kind === "voice" && wave.length ? {waveform:wave, duration:Number(audioAttribute?.duration) || undefined} : undefined;
      const attachment = kind === "document" ? {file_name:String(attribute(raw, "Filename")?.fileName ?? attribute(raw, "Filename")?.file_name ?? "file"), file_size:Number(document?.size) || undefined} : undefined;
      const audio = kind === "audio" ? {title:String(audioAttribute?.title ?? "Audio"), performer:audioAttribute?.performer ? String(audioAttribute.performer) : undefined, duration:Number(audioAttribute?.duration) || undefined} : undefined;
      const senderId = decimalId(forwarded?.peer ?? entity ?? raw?.senderId ?? source.envelope?.senderId);
      const status = options.hidden || forwarded?.anonymous ? undefined : emojiStatus(entity);
      const originalText = String(raw?.message ?? raw?.text ?? source.envelope?.text ?? "").replace(/\0/g, "");
      const text = originalText.trim() ? originalText : mediaFallback(kind);
      budget.text += Buffer.byteLength(text);
      if (budget.text > MAX_TEXT_BYTES) throw new QuoteBudgetError("QUOTE_TEXT_LIMIT");
      return {chatId:senderId, message_id:raw?.id ?? source.envelope?.id ?? 0,
        from:{id:senderId, name:options.hidden ? false : senderName, first_name:options.hidden ? false : senderName, photo:{}, emoji_status:status},
        name:options.hidden ? false : senderName, avatar:!options.hidden && !!avatar, avatarBuffer:avatar, avatarScale:options.scale,
        text, entities, caption:text, caption_entities:entities, replyMessage,
        forward:forwarded ? {label:forwarded.name} : undefined, mediaBuffer, mediaCanvas,
        mediaType:mediaCanvas ? (kind === "animation" ? "gif" : kind === "round" ? "video" : kind) : kind,
        mediaMaxSize:kind === "sticker" ? 220 * options.scale : undefined,
        mediaCrop:kind === "sticker" ? false : options.crop,
        mediaDuration:Number(attribute(raw, "Video")?.duration ?? audioAttribute?.duration) || undefined,
        voice, document:attachment, audio, emoji_status:status,
        date:raw?.date instanceof Date ? Math.floor(raw.date.getTime() / 1000) : raw?.date,
        via_bot:raw?.viaBotId ?? raw?.via_bot_id,
        senderTag:forwarded ? undefined : await senderRank(client, signal, raw, current)};
    };
    const output: Record<string, any>[] = [];
    for (const source of sources) output.push(await convert(source, true));
    await hydrateEmoji(context, client, signal, output, budget);
    signal.throwIfAborted();
    return output;
  });
}
