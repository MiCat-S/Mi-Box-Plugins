import type {MessageEnvelope, PluginContext} from "telebox/sdk";
import {avatar, mediaData} from "./media";
import {envelope, native, optional, replyMessage, UserError} from "./runtime";

export interface QuoteOptions {
  count: number;
  includeReply: boolean;
  format: "webp" | "image" | "stories";
  fakeText?: {text: string; entities: any[]};
  fakeSender?: any;
}

export function convertEntities(entities: readonly any[] = []): any[] {
  const names: Record<string, string> = {
    Bold: "bold", Italic: "italic", Underline: "underline", Strike: "strikethrough", Code: "code", Pre: "pre",
    CustomEmoji: "custom_emoji", Url: "url", TextUrl: "text_link", Mention: "mention", MentionName: "text_mention",
    Hashtag: "hashtag", Cashtag: "cashtag", BotCommand: "bot_command", Email: "email", Phone: "phone_number",
    Spoiler: "spoiler", Blockquote: "blockquote",
  };
  return entities.map(entity => {
    const name = (entity.className || entity._ || entity.constructor?.name || "").replace(/^MessageEntity|^messageEntity/, "");
    const type = names[name];
    const result: any = {offset: entity.offset, length: entity.length, ...(type ? {type} : {})};
    if (name === "CustomEmoji") result.custom_emoji_id = String(entity.documentId ?? entity.document_id ?? "");
    if (name === "TextUrl") result.url = entity.url || "";
    if (name === "MentionName") result.user = {id: exactId(entity.userId)};
    if (name === "Pre" && entity.language) result.language = entity.language;
    return result;
  });
}

export function exactId(value: any): string {
  return String(value ?? "0");
}

function hash(text: string): number {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = ((value << 5) - value + text.charCodeAt(i)) | 0;
  return value;
}

async function sender(ctx: PluginContext, message: any): Promise<any> {
  const cached = message.sender;
  if (cached) return cached;
  const resolved = typeof message.getSender === "function"
    ? await optional(ctx, "sender", () => native(ctx, () => message.getSender())) : undefined;
  if (resolved) return resolved;
  const peer = message.senderId ?? message.fromId ?? message.peerId;
  return peer ? optional(ctx, "sender.entity", () => native(ctx, client => client.getEntity(peer))) : undefined;
}

async function forwarded(ctx: PluginContext, message: any): Promise<any> {
  const header = message.fwdFrom || message.fwd_from;
  if (!header) return undefined;
  const cached = message.forward?.sender || message.forward?.chat;
  if (cached) return cached;
  for (const peer of [header.fromId, header.savedFromPeer, header.savedFromId].filter(Boolean)) {
    const entity = await optional(ctx, "forward", () => native(ctx, client => client.getEntity(peer)));
    if (entity) return entity;
  }
  const name = header.fromName || header.savedFromName || header.postAuthor || "未知来源";
  const peer = header.fromId || header.savedFromId || header.savedFromPeer;
  const id = peer?.userId ?? (peer?.chatId ? `-${peer.chatId}` : peer?.channelId ? `-${peer.channelId}` : hash(name));
  return {id, firstName: name, title: name, name, username: header.postAuthor};
}

async function replyBlock(ctx: PluginContext, message: any, parent: MessageEnvelope): Promise<any> {
  const header = message.replyTo;
  if (!message.isReply && !header?.replyToMsgId && !header?.quoteText) return undefined;
  const replied = await optional(ctx, "reply", () => replyMessage(ctx, envelope(message, parent)));
  const author = replied ? await sender(ctx, replied) : undefined;
  const quote = header?.quote && header.quoteText;
  const text = quote || replied?.message;
  if (!text) return undefined;
  return {
    name: author ? `${author.firstName || author.title || ""} ${author.lastName || ""}`.trim() || author.username || "unknown" : "unknown",
    text, entities: convertEntities((quote ? header.quoteEntities : replied?.entities) || []),
    ...(author?.id ? {chatId: exactId(author.id)} : {}),
  };
}

function advancedMedia(message: any): Record<string, unknown> {
  const media = message.media;
  if (!media) return {};
  const document = message.document || media.document;
  const attributes: any[] = document?.attributes || [];
  const find = (name: string) => attributes.find(a => (a.className || a.constructor?.name || "").includes(name));
  const audio = find("Audio"), video = find("Video");
  if (find("Sticker")) return {};
  if (audio?.voice) {
    const raw = audio.waveform;
    if (!raw || !raw.length) return {};
    const waveform = Array.from(raw as Uint8Array, v => Math.max(0, Math.min(31, Number(v) || 0)));
    return {voice: {waveform, ...(audio.duration ? {duration: Number(audio.duration)} : {})}};
  }
  if (audio) return {audio: {title: audio.title || audio.fileName || "Audio",
    ...(audio.performer ? {performer: audio.performer} : {}), ...(audio.duration ? {duration: Number(audio.duration)} : {})}};
  if (find("Animated") || video || (media.className || "").includes("Dice")) {
    return {mediaType: find("Animated") || (media.className || "").includes("Dice") ? "gif" : "video",
      ...(video?.duration ? {mediaDuration: Number(video.duration)} : {})};
  }
  if (document) return {document: {file_name: find("Filename")?.fileName || "file"}};
  return {};
}

export async function quoteData(ctx: PluginContext, invocation: MessageEnvelope, replied: any, options: QuoteOptions): Promise<any> {
  let messages: any[] = [replied];
  if (options.count > 1) {
    messages = await native(ctx, client => client.getMessages(replied.peerId || invocation.chatId, {
      offsetId: replied.id - 1, limit: options.count, reverse: true,
    }));
    if (!messages?.length) throw new UserError("未找到消息");
    if (!messages.some(message => message.id === replied.id)) messages = [replied, ...messages];
    messages = messages.slice(0, options.count);
  }
  const items: any[] = [];
  const avatars = new Map<string, {url: string} | undefined>();
  let previous: string | undefined;
  for (const [i, message] of messages.entries()) {
    ctx.signal.throwIfAborted();
    const forward = message.fwdFrom || message.fwd_from ? await forwarded(ctx, message) : undefined;
    let author = options.fakeSender || forward || await sender(ctx, message);
    if (!author) throw new UserError("无法获取消息发送者信息");
    if (author.id && (author.min || author.emojiStatus === undefined && author.emoji_status === undefined)) {
      author = await optional(ctx, "full.entity", () => native(ctx, client => client.getEntity(author))) || author;
    }
    const first = author.firstName || author.first_name || author.title || "";
    const last = author.lastName || author.last_name || "";
    const id = String(author.id ?? hash(author.name || `${first}|${last}`));
    const show = id !== previous;
    previous = id;
    if (show && !avatars.has(id)) avatars.set(id, await optional(ctx, "avatar", () => avatar(ctx, author)));
    const photo = show ? avatars.get(id) : undefined;
    const fake = i === 0 ? options.fakeText : undefined;
    const header = (invocation.raw as any)?.replyTo;
    const partial = i === 0 && !fake && header?.quoteText;
    const status = author.emojiStatus ?? author.emoji_status;
    const emoji = status?.documentId ?? status?.document_id ?? status?.customEmojiId ?? status?.custom_emoji_id ?? status?.id ??
      (typeof status === "string" ? status : undefined);
    const item: any = {
      from: {id: exactId(id), name: show ? author.name || "" : "",
        first_name: show ? first || undefined : undefined, last_name: show ? last || undefined : undefined,
        username: show && photo ? author.username || undefined : undefined, photo,
        emoji_status: show && emoji ? String(emoji) : undefined},
      text: fake?.text ?? (partial || message.message || ""),
      entities: convertEntities(fake?.entities ?? (partial ? header.quoteEntities : message.entities) ?? []), avatar: show,
    };
    if (options.includeReply) {
      const reply = await replyBlock(ctx, message, invocation);
      if (reply) item.replyMessage = reply;
    }
    if (!fake) {
      // Required media failures are visible, never silently converted into text-only quotes.
      const media = await mediaData(ctx, message);
      if (media) item.media = media;
      if (forward) item.forward = {label: forward.firstName || forward.title || forward.name || "Forwarded"};
      Object.assign(item, advancedMedia(message));
    }
    if (author.accessHash) {
      const {Api} = await import("teleproto");
      const result: any = await optional(ctx, "rank", () => native(ctx, client => client.invoke(new Api.channels.GetParticipant({
        channel: message.peerId || invocation.chatId,
        participant: new Api.InputUser({userId: author.id, accessHash: author.accessHash}),
      }))));
      if (result?.participant?.rank?.trim()) item.senderTag = result.participant.rank.trim();
    }
    items.push(item);
  }
  return {type: options.format === "webp" ? "quote" : options.format, format: options.format === "webp" ? "webp" : "png",
    backgroundColor: "#1b1429", width: options.format === "stories" ? 360 : 512,
    height: options.format === "stories" ? 640 : 768, scale: 2, emojiBrand: "apple", messages: items};
}
