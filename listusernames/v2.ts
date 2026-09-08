import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

type PublicChat = {id?: unknown; title?: unknown; username?: unknown; broadcast?: unknown};

function renderEntries(chats: readonly PublicChat[]): string[] {
  return chats.map((chat, index) => {
    const title = typeof chat.title === "string" && chat.title ? escape(chat.title) : "未知标题";
    const username = typeof chat.username === "string" && chat.username ? `@${escape(chat.username)}` : "无用户名";
    const id = chat.id === undefined ? "未知ID" : escape(String(chat.id));
    return `<b>${index + 1}.</b> ${title}（${chat.broadcast ? "📢 频道" : "👥 群组"}）\n用户名：<code>${username}</code>\nID：<code>${id}</code>`;
  });
}

function chunks(chats: readonly PublicChat[]): string[] {
  const entries = renderEntries(chats);
  const channelCount = chats.filter(chat => Boolean(chat.broadcast)).length;
  const header = `<b>属于我的公开群组/频道</b>\n共 <b>${chats.length}</b> 个`;
  const footer = `频道 ${channelCount} · 群组 ${chats.length - channelCount} · 总计 ${chats.length}`;
  const result: string[] = [];
  let current = header;
  for (const entry of entries) {
    if (`${current}\n\n${entry}`.length > 3900) {
      result.push(current);
      current = entry;
    } else current += `\n\n${entry}`;
  }
  if (`${current}\n\n${footer}`.length > 4000) result.push(current), current = footer;
  else current += `\n\n${footer}`;
  result.push(current);
  return result;
}

async function sendParts(message: MessageEnvelope, context: PluginContext, parts: readonly string[]): Promise<void> {
  await context.telegram.edit(message, parts[0]!, {parseMode: "html"});
  if (parts.length === 1) return;
  await context.telegram.withClient(async client => {
    const raw = message.raw as ApiTypes.Message | undefined;
    if (!raw?.peerId) throw new Error("Missing peer");
    for (const part of parts.slice(1)) {
      context.signal.throwIfAborted();
      await client.sendMessage(raw.peerId, {message: part, parseMode: "html", replyTo: message.id});
    }
  });
}

export default function createListUsernames() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "listusernames", description: "列出账号管理的公开群组和频道",
    commands: {listusernames: {helpArgs: ["help","h"], description: "列出账号管理的公开群组和频道", async handle(invocation, context) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
        await context.telegram.edit(invocation.message, `<b>公开群组/频道</b>\n<code>${escape(invocation.prefix)}listusernames</code>`, {parseMode: "html"});
        return;
      }
      await context.telegram.edit(invocation.message, "正在获取公开群组/频道列表…");
      try {
        const {Api} = await import("teleproto");
        const result = await context.telegram.invoke(new Api.channels.GetAdminedPublicChannels({})) as {chats?: unknown};
        if (!Array.isArray(result.chats) || result.chats.length === 0) {
          await context.telegram.edit(invocation.message, "<b>没有找到公开群组/频道</b>\n当前账号没有管理公开群组或频道", {parseMode: "html"});
          return;
        }
        await sendParts(invocation.message, context, chunks(result.chats as PublicChat[]));
      } catch {
        if (context.signal.aborted) return;
        context.log.error("listusernames_query_failed");
        await context.telegram.edit(invocation.message, "<b>获取列表失败</b>\n请稍后重试", {parseMode: "html"});
      }
    }}},
  });
}
