import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, ui, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

type PublicChat = {id?: unknown; title?: unknown; username?: unknown; broadcast?: unknown};
class OutputDeliveryError extends Error {
  constructor() { super("LISTUSERNAMES_OUTPUT_DELIVERY_FAILED"); }
}

function renderEntries(chats: readonly PublicChat[]): string[] {
  return chats.map((chat, index) => {
    const title = typeof chat.title === "string" && chat.title ? escape(chat.title) : "未知标题";
    const username = typeof chat.username === "string" && chat.username ? `@${escape(chat.username)}` : "无用户名";
    const id = chat.id ? escape(String(chat.id)) : "未知ID";
    return `<b>${index + 1}.</b> ${title} (${chat.broadcast ? "📢 频道" : "👥 群组"})\n   👤 用户名: <code>${username}</code>\n   🆔 ID: <code>${id}</code>`;
  });
}

async function chunks(chats: readonly PublicChat[]): Promise<readonly string[]> {
  const entries = renderEntries(chats);
  const channelCount = chats.filter(chat => Boolean(chat.broadcast)).length;
  const output = `📋 <b>属于我的公开群组/频道</b>\n\n共找到 <b>${chats.length}</b> 个公开群组/频道：\n\n` +
    entries.join("\n\n") + `\n\n📊 <b>统计信息：</b>\n• 频道数量: ${channelCount}\n• 群组数量: ${chats.length - channelCount}\n• 总计: ${chats.length}`;
  if (output.length <= ui.MAX_HTML_LENGTH) return [output];
  const pages = await ui.renderRichText(output, ui.PAGE_LABEL_RESERVE);
  return pages.map((page, index, all) => page + ui.pageLabel(index, all.length));
}

async function sendParts(message: MessageEnvelope, context: PluginContext, parts: readonly string[]): Promise<void> {
  const send = async (client?: {sendMessage(peer: unknown, value: unknown): Promise<unknown>}) => {
    const raw = message.raw as ApiTypes.Message | undefined;
    if (parts.length > 1 && !raw?.peerId) throw new OutputDeliveryError();
    const delivery = await ui.deliverPages(parts, context.signal, (part, index) => index
      ? client!.sendMessage(raw!.peerId, {message: part, parseMode: "html", replyTo: message.id}).then(() => undefined)
      : context.telegram.edit(message, part, {parseMode: "html"}));
    if (delivery.interrupted) {
      context.log.info("listusernames_delivery_interrupted", {published: delivery.published, total: delivery.total, category: ui.deliveryErrorCategory(delivery.error)});
      if (!delivery.published) throw new OutputDeliveryError();
      try { await context.telegram.reply(message, ui.interruptedNotice(delivery), {parseMode: "html"}); } catch {}
    }
  };
  if (parts.length === 1) await send();
  else await context.telegram.withClient(client => send(client));
}

export default function createListUsernames() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "listusernames", description: "列出账号管理的公开群组和频道",
    commands: {listusernames: {helpArgs: ["help","h"], description: "列出账号管理的公开群组和频道", async handle(invocation, context) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
        await context.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), {parseMode: "html"});
        return;
      }
      await context.telegram.edit(invocation.message, "🔄 <b>正在获取公开群组/频道列表...</b>", {parseMode: "html"});
      try {
        const {Api} = await import("teleproto");
        const result = await context.telegram.invoke(new Api.channels.GetAdminedPublicChannels({})) as {chats?: unknown};
        if (!Array.isArray(result.chats) || result.chats.length === 0) {
          await context.telegram.edit(invocation.message, "📭 <b>没有找到公开群组/频道</b>\n\n您目前没有拥有任何公开群组或频道", {parseMode: "html"});
          return;
        }
        await sendParts(invocation.message, context, await chunks(result.chats as PublicChat[]));
      } catch (error) {
        if (error instanceof OutputDeliveryError) throw error;
        if (context.signal.aborted) return;
        context.log.error("listusernames_query_failed");
        await context.telegram.edit(invocation.message, "❌ <b>获取列表失败</b>\n\n请稍后重试", {parseMode: "html"});
      }
    }}},
  });
}
