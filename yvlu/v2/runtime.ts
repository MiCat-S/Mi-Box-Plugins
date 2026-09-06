import type {MessageEnvelope, PluginContext} from "telebox/sdk";

export const escape = (value: unknown): string => String(value).replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]!);

export class UserError extends Error {}

/** Every native operation remains owned until settlement, including ignored cancellation. */
export function native<T>(ctx: PluginContext, use: (client: any) => Promise<T>): Promise<T> {
  ctx.signal.throwIfAborted();
  return ctx.telegram.withClient(async (client, signal) => {
    signal.throwIfAborted();
    const result = await use(client);
    signal.throwIfAborted();
    return result;
  });
}

export async function optional<T>(ctx: PluginContext, label: string, use: () => Promise<T>): Promise<T | undefined> {
  try { return await use(); }
  catch {
    ctx.signal.throwIfAborted();
    ctx.log.info(`yvlu.optional.${label}.failed`);
    return undefined;
  }
}

export function envelope(raw: any, parent: MessageEnvelope): MessageEnvelope {
  return {id: raw.id, chatId: raw.chatId?.toString() ?? parent.chatId,
    senderId: raw.senderId?.toString(), text: raw.message || "", outgoing: Boolean(raw.out),
    replyToId: raw.replyTo?.replyToMsgId, topicId: parent.topicId, raw};
}

export async function rawMessage(ctx: PluginContext, message: MessageEnvelope): Promise<any> {
  if (message.raw) return message.raw;
  const messages: any = await native(ctx, client => client.getMessages(message.chatId, {ids: [message.id]}));
  if (!messages?.[0]) throw new UserError("未找到消息");
  return messages[0];
}

export async function replyMessage(ctx: PluginContext, message: MessageEnvelope): Promise<any | undefined> {
  const reply = await ctx.telegram.getReply(message);
  return reply ? rawMessage(ctx, reply) : undefined;
}
