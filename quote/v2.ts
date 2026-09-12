import {writeFile} from "node:fs/promises";
import path from "node:path";
import {
  STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp,
  type CommandDefinition, type CommandInvocation, type MessageEnvelope, type PluginContext, type SubcommandDefinition,
} from "telebox/sdk";
import {renderQuote, type QuoteRenderMessage, type QuoteRenderOptions} from "./v2/render";

const MAX_MESSAGES = 50;
const MAX_TEXT_BYTES = 24 * 1024;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 32 * 1024 * 1024;
const MAX_DECODE_PIXELS = 20_000_000;
const MAX_IMAGE_OUTPUT_BYTES = 20 * 1024 * 1024;

type ParsedOptions = QuoteRenderOptions & {count: number; replies: boolean; media: boolean; explicitCount: boolean};

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g, character =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function peerId(value: any): string | undefined {
  const id = value?.userId ?? value?.chatId ?? value?.channelId ?? value?.id ?? value;
  if (typeof id === "bigint" || typeof id === "number" || typeof id === "string") return String(id);
  if (id && typeof id.toString === "function") {
    const text = id.toString();
    if (/^-?\d+$/.test(text)) return text;
  }
  return undefined;
}

function parseOptions(args: readonly string[]): ParsedOptions {
  let count = 1, format: ParsedOptions["format"] = "webp", background: string | undefined;
  let scale = 1, replies = false, media = true, hidden = false, crop = false, explicitCount = false;
  for (let index = 0; index < args.length; index++) {
    const raw = args[index]!;
    const token = raw.toLowerCase();
    if (/^[+-]?\d+$/.test(token)) { count = Number(token); explicitCount = true; continue; }
    if (["webp", "sticker", "quote"].includes(token)) { format = "webp"; continue; }
    if (["png", "image", "img"].includes(token)) { format = "png"; continue; }
    if (["story", "stories"].includes(token)) { format = "story"; continue; }
    if (["reply", "replies", "r"].includes(token)) { replies = true; continue; }
    if (["no-reply", "noreply"].includes(token)) { replies = false; continue; }
    if (["media", "m"].includes(token)) { media = true; continue; }
    if (["no-media", "nomedia"].includes(token)) { media = false; continue; }
    if (["hidden", "hide", "anonymous"].includes(token)) { hidden = true; continue; }
    if (token === "crop") { crop = true; continue; }
    if (["rate", "rating"].includes(token) || ["apple", "google", "twitter", "joypixels", "blob"].includes(token)) continue;
    const scaleMatch = token.match(/^(?:scale|s)[=:](\d+(?:\.\d+)?)$/);
    if (scaleMatch) { scale = Number(scaleMatch[1]); continue; }
    if (["scale", "s"].includes(token) && args[index + 1] && /^\d+(?:\.\d+)?$/.test(args[index + 1]!)) {
      scale = Number(args[++index]); continue;
    }
    const backgroundMatch = raw.match(/^(?:background|bg|color)[=:](.+)$/i);
    if (backgroundMatch) { background = backgroundMatch[1]!.trim(); continue; }
    if (["background", "bg", "color"].includes(token) && args[index + 1]) { background = args[++index]!.trim(); continue; }
    if (token === "random" || /^#?[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(token)) { background = token.startsWith("#") ? token : token === "random" ? token : `#${token}`; continue; }
    throw new Error(`无法识别参数：${raw}`);
  }
  if (!Number.isSafeInteger(count) || count === 0 || Math.abs(count) > MAX_MESSAGES) throw new Error(`消息数量必须为 ±1-${MAX_MESSAGES}`);
  if (!Number.isFinite(scale) || scale < 1 || scale > 3) throw new Error("scale 必须为 1-3");
  return {count, format, background, scale, replies, media, hidden, crop, explicitCount};
}

function textOf(raw: any, envelope?: MessageEnvelope): string {
  return String(raw?.message ?? raw?.text ?? envelope?.text ?? "").replace(/\u0000/g, "").slice(0, 4_000);
}

function mediaLabel(raw: any): string | undefined {
  if (raw?.photo) return "🖼 图片";
  if (raw?.sticker) return "🏷 贴纸";
  if (raw?.video) return "🎬 视频";
  if (raw?.gif) return "🎞 动图";
  if (raw?.voice) return "🎙 语音";
  if (raw?.audio) return "🎵 音频";
  if (raw?.document) return `📎 ${String(raw?.file?.name ?? "文件").slice(0, 60)}`;
  if (raw?.poll) return "📊 投票";
  if (raw?.media) return "📎 媒体";
  return undefined;
}

function canPreview(raw: any): boolean {
  if (raw?.photo) return true;
  const mime = String(raw?.document?.mimeType ?? raw?.file?.mimeType ?? "").toLowerCase();
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "application/x-tgsticker";
}

async function preview(client: any, signal: AbortSignal, raw: any, budget: {total: number}, crop: boolean): Promise<Buffer | undefined> {
  if (!canPreview(raw) || !raw?.media || budget.total >= MAX_TOTAL_MEDIA_BYTES) return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of client.iterDownload(raw.media, {})) {
    signal.throwIfAborted();
    const value = Buffer.from(chunk);
    total += value.length; budget.total += value.length;
    if (total > MAX_MEDIA_BYTES || budget.total > MAX_TOTAL_MEDIA_BYTES) throw new Error("引用媒体超过 32 MiB 总上限");
    chunks.push(value);
  }
  if (!total) return undefined;
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.concat(chunks, total), {animated: false, pages: 1, limitInputPixels: MAX_DECODE_PIXELS}).rotate()
    .resize({width: 584, height: 240, fit: crop ? "cover" : "inside", withoutEnlargement: !crop}).png().toBuffer();
}

async function sender(raw: any, envelope?: MessageEnvelope): Promise<{id: string; name: string}> {
  let entity = raw?.sender;
  if (!entity && typeof raw?.getSender === "function") {
    try { entity = await raw.getSender(); } catch { entity = undefined; }
  }
  const id = peerId(entity) ?? peerId(raw?.senderId) ?? envelope?.senderId ?? "0";
  const name = [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") || entity?.title ||
    (entity?.username ? `@${entity.username}` : "") || raw?.postAuthor || `ID ${id}`;
  return {id, name: String(name).slice(0, 80)};
}

async function replyPreview(client: any, raw: any): Promise<{sender: string; text: string} | undefined> {
  const replyId = Number(raw?.replyTo?.replyToMsgId ?? raw?.replyToMsgId ?? 0);
  if (!replyId || !raw?.peerId) return undefined;
  const values = await client.getMessages(raw.peerId, {ids: [replyId]});
  const reply = values?.[0];
  if (!reply) return undefined;
  const author = await sender(reply);
  return {sender: author.name, text: textOf(reply).slice(0, 240)};
}

async function collect(context: PluginContext, invocation: CommandInvocation, count: number): Promise<Array<{raw: any; envelope?: MessageEnvelope}>> {
  const replied = invocation.message.replyToId === undefined ? undefined : await context.telegram.getReply(invocation.message);
  const baseEnvelope = replied?.raw ? replied : invocation.message;
  if (!baseEnvelope.raw) throw new Error("无法读取引用消息");
  if (Math.abs(count) === 1) return [{raw: baseEnvelope.raw, envelope: baseEnvelope}];
  return context.telegram.withClient(async (client: any) => {
    const base: any = baseEnvelope.raw;
    if (!base?.peerId) throw new Error("无法确定被回复消息的会话");
    const limit = Math.abs(count), values: any[] = count > 0 ?
      await client.getMessages(base.peerId, {minId: baseEnvelope.id, limit: limit - 1, reverse: true}) :
      await client.getMessages(base.peerId, {maxId: baseEnvelope.id, limit: limit - 1});
    const byId = new Map<number, any>([[baseEnvelope.id, base]]);
    for (const value of values || []) if (Number.isSafeInteger(Number(value?.id))) byId.set(Number(value.id), value);
    const ordered = [...byId.entries()].sort((left, right) => left[0] - right[0]);
    const selected = count > 0 ? ordered.slice(0, limit) : ordered.slice(-limit);
    return selected.map(([id, raw]) => ({raw, envelope: id === baseEnvelope.id ? baseEnvelope : undefined}));
  });
}

async function renderAndSend(invocation: CommandInvocation, context: PluginContext, fakeText?: string): Promise<void> {
  const options = parseOptions(fakeText === undefined ? invocation.args : []);
  const sources = await collect(context, invocation, fakeText === undefined ? options.count : 1);
  const budget = {total: 0};
  const output: QuoteRenderMessage[] = [];
  let textBytes = 0;
  await context.telegram.withClient(async (client: any, signal) => {
    for (const source of sources) {
      context.signal.throwIfAborted();
      const author = await sender(source.raw, source.envelope);
      const text = fakeText === undefined ? textOf(source.raw, source.envelope) : fakeText.slice(0, 4_000);
      textBytes += Buffer.byteLength(text);
      if (textBytes > MAX_TEXT_BYTES) throw new Error("引用文字超过 24 KiB 总上限");
      const forwarded = source.raw?.fwdFrom ? `转发${source.raw.fwdFrom.fromName ? `自 ${source.raw.fwdFrom.fromName}` : ""}` : undefined;
      const rank = String(source.raw?.postAuthor ?? "").trim();
      output.push({senderId: author.id, sender: author.name, text,
        tag: [forwarded, rank].filter(Boolean).join(" · ") || undefined,
        reply: options.replies ? await replyPreview(client, source.raw) : undefined,
        mediaLabel: options.media ? mediaLabel(source.raw) : undefined,
        media: options.media ? await preview(client, signal, source.raw, budget, options.crop === true) : undefined});
    }
  });
  const result = await renderQuote(output, options);
  if (result.length > (options.format === "webp" ? 512 * 1024 : MAX_IMAGE_OUTPUT_BYTES)) throw new Error("引用图片超过输出大小上限");
  await context.files.withTemp(async (directory, signal) => {
    const extension = options.format === "webp" ? "webp" : "png";
    const file = path.join(directory, `quote.${extension}`);
    await writeFile(file, result, {mode: 0o600, signal});
    await context.telegram.withClient(async (client: any) => {
      const {Api} = await import("teleproto");
      const raw: any = invocation.message.raw;
      if (!raw?.peerId) throw new Error("无法确定发送会话");
      const sendOptions: any = {file, replyTo: invocation.message.replyToId ?? invocation.message.id};
      if (options.format === "webp") sendOptions.attributes = [new Api.DocumentAttributeSticker({alt: "💬", stickerset: new Api.InputStickerSetEmpty()})];
      else sendOptions.forceDocument = false;
      await client.sendFile(raw.peerId, sendOptions);
      if (typeof raw.delete === "function") {
        try { await raw.delete({revoke: true}); }
        catch { context.log.error("quote_command_cleanup_failed"); }
      }
    });
  });
}

export default function createQuote() {
  const fake: SubcommandDefinition = {
    description: "以被回复消息的发送者显示自定义文字", args: "[文字]",
    arguments: [{name: "文字", description: "明确标记为自定义内容；最多 4000 字"}],
    examples: [{args: "fake 这是自定义引用"}],
    async handle(invocation, context) {
      const value = invocation.args.join(" ").trim();
      if (!value) { await context.telegram.edit(invocation.message, "请提供 fake 的自定义文字"); return; }
      try { await renderAndSend(invocation, context, value); }
      catch (error) { if (!context.signal.aborted) await context.telegram.edit(invocation.message, `引用生成失败：${String((error as Error)?.message ?? error).slice(0, 240)}`); }
    },
  };
  const command: CommandDefinition = {
    description: "将回复的消息生成引用贴纸或图片", args: "[数量] [webp|png|story] [选项]", helpArgs: ["help", "h"],
    arguments: [
      {name: "数量", description: "正数向后、负数向前引用，范围 ±1-50，默认 1；不回复时以命令消息为边界"},
      {name: "格式", description: "webp（默认贴纸）、png 或 story"},
      {name: "选项", description: "reply/no-reply、hidden、media/no-media、crop、scale=1..3、bg=颜色/dusk/ocean/forest/graphite/sunrise/random"},
    ],
    examples: [{args: ""}, {args: "3 png bg=ocean"}, {args: "1 story no-media"}],
    help: [{heading: "范围与媒体：", body: "可回复消息或直接使用命令；正数向后、负数向前引用最多 50 条。图片会下载后生成静态预览，单项最多 12 MiB、合计最多 32 MiB、解码最多 2000 万像素；视频、语音和文件以类型标签显示。"},
      {heading: "真实性与依赖：", body: "fake 子命令会明确采用自定义文字；普通参数无法伪造发送者。渲染使用宿主已有的 canvas 与 sharp，不会联网下载资源或运行 npm 安装。"}],
    subcommands: {fake}, subcommandsCaseSensitive: false,
    async handle(invocation, context) {
      try { await renderAndSend(invocation, context); }
      catch (error) {
        if (context.signal.aborted) return;
        context.log.error("quote_failed", {code: String((error as any)?.code ?? "FAILED").slice(0, 80)});
        await context.telegram.edit(invocation.message, `引用生成失败：${String((error as Error)?.message ?? error).slice(0, 240)}`);
      }
    },
  };
  const help = (prefix: string) => renderCommandHelp("quote", command, {prefix, title: "💬 引用图片"});
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "quote", description: "把 Telegram 消息生成引用贴纸或图片",
    renderHelp: help, commands: {quote: command, q: command}});
}
