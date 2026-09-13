import {ui, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {escape, type Source} from "./text";
import {markdownToHtml} from "./markdown";

function peerOf(message: MessageEnvelope): unknown {
  const raw = message.raw as {inputChat?: unknown; peerId?: unknown} | undefined;
  return raw?.inputChat ?? raw?.peerId ?? message.chatId;
}

/** Sends a new message (never an edit) and returns its real id for anchoring continuations. */
async function sendNew(ctx: PluginContext, message: MessageEnvelope, html: string, replyToId: number | undefined, signal: AbortSignal): Promise<number | undefined> {
  return ctx.telegram.withClient(async (client: any, active: AbortSignal) => {
    const combined = AbortSignal.any([signal, active]);
    combined.throwIfAborted();
    const topicRoot = (message as unknown as {topicId?: number}).topicId;
    const replyTo = replyToId ?? topicRoot;
    const sent = await client.sendMessage(peerOf(message), {
      message: html, parseMode: "html", linkPreview: false, ...(replyTo ? {replyTo} : {}),
    });
    combined.throwIfAborted();
    return sent?.id as number | undefined;
  });
}

/** Best-effort deletion: a failure is logged, never reported as a business failure. */
async function deleteCommand(ctx: PluginContext, message: MessageEnvelope, signal: AbortSignal): Promise<void> {
  try {
    await ctx.telegram.withClient(async (client: any, active: AbortSignal) => {
      const combined = AbortSignal.any([signal, active]);
      combined.throwIfAborted();
      await client.deleteMessages(peerOf(message), [message.id], {revoke: true});
      combined.throwIfAborted();
    });
  } catch {
    if (!ctx.signal.aborted) ctx.log.error("ai:command-delete-failed");
  }
}

export function sourcesHtml(sources: readonly Source[]): string {
  if (!sources.length) return "";
  return "\n\n<b>🔗 Sources</b>\n" + sources.slice(0, 8)
    .map((source, index) => `${index + 1}. <a href="${escape(source.url)}">${escape(source.title || source.url)}</a>`)
    .join("\n");
}

/** Budget reserved for the collapse wrapper, continuation label, signature and page label. */
const DELIVERY_RESERVE = ui.PAGE_LABEL_RESERVE + 48 + 32 + 32;

async function paginate(source: string, collapse: boolean, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const pages = await ui.renderRichText(source, DELIVERY_RESERVE);
  const usable = pages.length ? pages : [source];
  return usable.map(page => collapse ? `<blockquote expandable>${page}</blockquote>` : page);
}

async function deliverPages(ctx: PluginContext, message: MessageEnvelope, pages: readonly string[],
  powered: string, replyToId: number | undefined, signal: AbortSignal): Promise<void> {
  let firstId: number | undefined;
  for (let index = 0; index < pages.length; index++) {
    signal.throwIfAborted();
    const label = index === 0 ? "" : `📋 <b>续 (${index}/${pages.length - 1}):</b>\n\n`;
    const suffix = index === pages.length - 1 ? powered : "";
    const id = await sendNew(ctx, message, label + pages[index] + suffix, index === 0 ? replyToId : firstId, signal);
    if (index === 0) firstId = id;
  }
}

export interface AnswerDelivery {
  question: string;
  answer: string;
  sources?: readonly Source[];
  tag: string;
  collapse: boolean;
  replyToId?: number;
}

/**
 * Renders the answer as safe markdown HTML, delivers it as one or more new
 * messages (first anchored to the reply target, continuations anchored to the
 * first answer), then best-effort deletes the command message.
 */
export async function deliverAnswer(ctx: PluginContext, message: MessageEnvelope, delivery: AnswerDelivery, signal: AbortSignal): Promise<void> {
  const {question, answer, sources = [], tag, collapse, replyToId} = delivery;
  const htmlAnswer = markdownToHtml(answer, {collapseSafe: collapse});
  const source = `Q:\n${escape(question)}\n\nA:\n${htmlAnswer}${sourcesHtml(sources)}`;
  const pages = await paginate(source, collapse, signal);
  const powered = tag ? `\n<i>🍀Powered by ${escape(tag)}</i>` : "";
  await deliverPages(ctx, message, pages, powered, replyToId, signal);
  await deleteCommand(ctx, message, signal);
}

/** Short Q + Telegraph link delivery used when the answer is too long to inline. */
export async function deliverTelegraphAnswer(ctx: PluginContext, message: MessageEnvelope,
  delivery: {question: string; url: string; tag: string; collapse: boolean; replyToId?: number}, signal: AbortSignal): Promise<void> {
  const link = `📰内容比较长，Telegraph 观感更好喔:\n🔗 <a href="${escape(delivery.url)}">点我阅读内容</a>`;
  const source = `Q:\n${escape(delivery.question)}\n\nA:\n${link}`;
  const pages = await paginate(source, delivery.collapse, signal);
  const powered = delivery.tag ? `\n<i>🍀Powered by ${escape(delivery.tag)}</i>` : "";
  await deliverPages(ctx, message, pages, powered, delivery.replyToId, signal);
  await deleteCommand(ctx, message, signal);
}
