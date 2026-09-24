import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, ui, type MessageEnvelope, type PluginContext } from "telebox/sdk";

const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[c]!,
  );
const HELP = `📜 <b>消息历史查询</b>\n\n<b>使用方法：</b>\n• <code>{p}his</code> - 回复消息时查询该用户历史\n• <code>{p}his &lt;目标&gt;</code> - 查询目标的消息历史\n• <code>{p}his &lt;目标&gt; &lt;数量&gt;</code> - 查询指定数量消息\n• <code>{p}his &lt;数量&gt;</code> - 回复消息时查询指定数量\n\n<b>注意事项：</b>\n• 仅限群组使用\n• 默认查询30条消息\n• 目标可以是用户名、用户ID或频道ID`;
class UserError extends Error {
  constructor(readonly feedback: string) {
    super("HIS_USER_ERROR");
  }
}
const floodSeconds = (detail: string) => detail.match(/(?:^|\b)FLOOD_WAIT[_ ]?(\d+)(?:\b|$)/)?.[1];

function mediaText(message: any, caption: string): string {
  const media = message.media;
  if (!media) return caption;
  if (media.className === "MessageMediaPhoto") return `[图片] ${caption}`;
  if (media.className === "MessageMediaDocument") {
    const attrs: any[] = media.document?.attributes ?? [];
    if (attrs.some(a => a.className === "DocumentAttributeSticker")) return `[贴纸] ${caption}`;
    if (attrs.some(a => a.className === "DocumentAttributeAnimated")) return `[动画] ${caption}`;
    if (attrs.some(a => a.className === "DocumentAttributeVideo")) return `[视频] ${caption}`;
    if (attrs.some(a => a.className === "DocumentAttributeAudio" && a.voice)) return `[语音] ${caption}`;
    if (attrs.some(a => a.className === "DocumentAttributeAudio")) return `[音频] ${caption}`;
    return `[文档] ${caption}`;
  }
  const names: Record<string, string> = {
    MessageMediaContact: "[联系人]",
    MessageMediaGeo: "[位置]",
    MessageMediaVenue: "[地点]",
    MessageMediaPoll: "[投票]",
    MessageMediaWebPage: "[网页]",
    MessageMediaDice: "[骰子]",
    MessageMediaGame: "[游戏]",
  };
  return `${names[media.className] ?? ""} ${caption}`.trim();
}

async function query(message: MessageEnvelope, target: string, count: number, ctx: PluginContext) {
  await ctx.telegram.edit(message, "🔍 正在查询消息历史...", { parseMode: "html" });
  ctx.signal.throwIfAborted();
  await ctx.telegram.withClient(async (client: any, signal) => {
    const { returnBigInt } = await import("teleproto/Helpers.js");
    signal.throwIfAborted();
    const chat: any = (message.raw as any)?.peerId ?? returnBigInt(message.chatId);
    const targetEntity = /^-?\d+$/.test(target) ? returnBigInt(target) : target;
    let display = target,
      base = "";
    try {
      const entity: any = await client.getEntity(targetEntity);
      signal.throwIfAborted();
      display =
        [entity.title, entity.firstName, entity.lastName, entity.username && `@${entity.username}`]
          .filter(Boolean)
          .join(" ") || target;
    } catch {
      signal.throwIfAborted();
    }
    try {
      const entity: any = await client.getEntity(chat);
      signal.throwIfAborted();
      if (entity.username) base = `https://t.me/${entity.username}/`;
      else if (entity.megagroup) base = `https://t.me/c/${String(entity.id).replace("-100", "")}/`;
    } catch {
      signal.throwIfAborted();
    }
    const lines: string[] = [];
    let index = 0;
    signal.throwIfAborted();
    for await (const item of client.iterMessages(chat, { limit: count, fromUser: targetEntity })) {
      signal.throwIfAborted();
      index++;
      let text = mediaText(item, item.text || item.message || "");
      if (item.className === "MessageService")
        text =
          item.action?.className === "MessageActionPinMessage"
            ? `[置顶消息] ${item.action.message ?? ""}`
            : item.action?.className === "MessageActionChatEditTitle"
              ? `[修改群名] ${item.action.title ?? ""}`
              : `[服务消息] ${String(item.action?.className ?? "").replace("MessageAction", "")}`;
      if (!text) text = "[Unsupported Message]";
      const characters = [...text];
      const brief = characters.length > 50 ? `${characters.slice(0, 50).join("")}...` : text;
      lines.push(base ? `${index}. <a href="${base}${item.id}">${escape(brief)}</a>` : `${index}. ${escape(brief)}`);
    }
    signal.throwIfAborted();
    if (!lines.length) {
      await ctx.telegram.edit(message, `❌ 未找到 <b>${escape(display)}</b> 的消息记录`, { parseMode: "html" });
      return;
    }
    const header = `📜 <b>消息历史查询</b>\n\n👤 <b>目标:</b> ${escape(display)}\n💬 <b>消息数:</b> ${lines.length}\n━━━━━━━━━━━━━━━━\n\n`;
    const rendered = await ui.renderRichText(header + lines.join("\n"), ui.PAGE_LABEL_RESERVE);
    signal.throwIfAborted();
    const pages = rendered.map((page, index) => page + ui.pageLabel(index, rendered.length));
    const delivery = await ui.deliverPages(pages, signal, (page, index) =>
      index
        ? ctx.telegram.reply(message, page, { parseMode: "html", linkPreview: false })
        : ctx.telegram.edit(message, page, { parseMode: "html", linkPreview: false }),
    );
    if (delivery.interrupted) {
      ctx.log.info("pagination_delivery_interrupted", {
        plugin: "his",
        published: delivery.published,
        total: delivery.total,
        category: ui.deliveryErrorCategory(delivery.error),
      });
      if (!delivery.published) throw delivery.error;
      try {
        await ctx.telegram.reply(message, ui.interruptedNotice(delivery), { parseMode: "html" });
      } catch {}
    }
  });
}

export default function createHis() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "his",
    description: "查询指定用户或频道在群内的发言历史",
    commands: {
      his: {
        helpArgs: ["help", "h"],
        description: "查询消息历史",
        async handle({ message, args, prefix }, ctx) {
          try {
            if (args[0] === "help" || args[0] === "h") {
              await ctx.telegram.edit(message, HELP.replaceAll("{p}", escape(prefix)), { parseMode: "html" });
              return;
            }
            let target: string | undefined,
              count = 30;
            if (!args.length || (args.length === 1 && /^\d+$/.test(args[0]) && message.replyToId)) {
              const reply = await ctx.telegram.getReply(message);
              target = reply?.senderId;
              if (args[0]) count = Math.min(Number(args[0]), 100);
            } else if (args.length <= 2) {
              target = args[0];
              if (args[1]) {
                const parsed = Number(args[1]);
                if (!Number.isInteger(parsed) || parsed <= 0) throw new UserError("❌ 无效的数量参数");
                count = Math.min(parsed, 100);
              }
            } else throw new UserError(`❌ 参数过多，请使用 ${escape(prefix)}his help 查看帮助`);
            if (!target) throw new UserError("❌ 请回复一条消息或指定查询目标");
            await query(message, target, count, ctx);
          } catch (error: any) {
            if (ctx.signal.aborted) return;
            const detail = error instanceof Error ? error.message : "";
            const wait = floodSeconds(detail);
            await ctx.telegram.edit(
              message,
              error instanceof UserError
                ? error.feedback
                : wait
                  ? `⏳ <b>请求过于频繁</b>\n\n需要等待 ${wait} 秒后重试`
                  : /\bMESSAGE_TOO_LONG\b/.test(detail)
                    ? "❌ <b>消息过长</b>\n\n请减少查询数量"
                    : "❌ <b>操作失败</b>，请稍后重试",
              { parseMode: "html" },
            );
          }
        },
      },
    },
  });
}
