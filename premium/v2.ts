import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin } from "telebox/sdk";
import { Api, helpers, utils } from "teleproto";

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>\"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );
function peer(chatId: string): Api.TypePeer {
  const [id, Peer] = utils.resolveId(helpers.returnBigInt(chatId));
  if (Peer === Api.PeerUser) return new Api.PeerUser({ userId: id });
  if (Peer === Api.PeerChat) return new Api.PeerChat({ chatId: id });
  return new Api.PeerChannel({ channelId: id });
}
function userOf(value: unknown): Api.User | undefined {
  if (value instanceof Api.User) return value;
  if (value instanceof Api.ChannelParticipant) {
    const user = (value as Api.ChannelParticipant & { user?: unknown }).user;
    return user instanceof Api.User ? user : undefined;
  }
  return;
}
function failure(error: unknown): string {
  if (!error || typeof error !== "object") return "请确认当前会话是可访问成员列表的群组";
  const values = [
    Object.getOwnPropertyDescriptor(error, "errorMessage")?.value,
    Object.getOwnPropertyDescriptor(error, "message")?.value,
  ].filter(v => typeof v === "string") as string[];
  const text = values.join(" ");
  if (text.includes("CHAT_ADMIN_REQUIRED")) return "需要管理员权限才能查看群组成员列表";
  if (text.includes("CHANNEL_PRIVATE")) return "无法访问该群组，请确认当前账号仍是群组成员";
  if (text.includes("AUTH_KEY_UNREGISTERED")) return "会话未注册，请重新登录";
  const match = /FLOOD_WAIT[_ ]?(\d+)/.exec(text);
  if (match) {
    const seconds = Number(match[1]);
    if (Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86400)
      return `请求过于频繁，请等待 ${seconds} 秒后重试`;
  }
  return "请确认当前会话是可访问成员列表的群组";
}

export default function createPremium() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "premium",
    description: "统计群组 Telegram Premium 用户比例",
    commands: {
      premium: {
        helpArgs: ["help", "h"],
        description: "统计群组 Telegram Premium 用户比例",
        async handle(invocation, context) {
          if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
            await context.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), { parseMode: "html" });
            return;
          }
          try {
            await context.telegram.edit(invocation.message, "正在统计群组成员…");
            context.signal.throwIfAborted();
            await context.telegram.withClient(async (client, clientSignal) => {
              const signal = AbortSignal.any([context.signal, clientSignal]);
              signal.throwIfAborted();
              const raw = invocation.message.raw as Api.Message | undefined;
              const chat = await client.getEntity(raw?.peerId ?? peer(invocation.message.chatId));
              signal.throwIfAborted();
              if (!(chat instanceof Api.Chat || chat instanceof Api.Channel)) throw new Error("Not a group");
              let participantCount =
                "participantsCount" in chat && typeof chat.participantsCount === "number" ? chat.participantsCount : 0;
              if (chat instanceof Api.Channel) {
                try {
                  const full = await client.invoke(new Api.channels.GetFullChannel({ channel: chat }));
                  signal.throwIfAborted();
                  const count = (full.fullChat as { participantsCount?: unknown }).participantsCount;
                  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) participantCount = count;
                } catch {
                  signal.throwIfAborted();
                  context.log.error("premium_count_failed");
                }
              }
              if (participantCount >= 10_000 && invocation.args[0] !== "force") {
                await context.telegram.edit(
                  invocation.message,
                  `<b>群组人数较多</b>\n使用 <code>${escape(invocation.prefix)}premium force</code> 统计前 10,000 名成员`,
                  { parseMode: "html" },
                );
                signal.throwIfAborted();
                return;
              }
              let premium = 0,
                users = 0,
                bots = 0,
                deleted = 0,
                processed = 0;
              for await (const participant of client.iterParticipants(chat, { limit: 10_000 })) {
                signal.throwIfAborted();
                processed++;
                if (processed % 100 === 0) {
                  await context.telegram.edit(invocation.message, `正在统计群组成员… 已处理 ${processed} 个成员`, {
                    parseMode: "html",
                  });
                  signal.throwIfAborted();
                }
                const user = userOf(participant);
                if (!user) continue;
                if (user.bot) bots++;
                else if (user.deleted) deleted++;
                else {
                  users++;
                  if (user.premium) premium++;
                }
              }
              const percent = users ? ((premium / users) * 100).toFixed(2) : "0.00";
              const limited =
                participantCount >= 10_000 ? "\n\n<i>Telegram 最多返回前 10,000 名成员，结果可能不完整。</i>" : "";
              await context.telegram.edit(
                invocation.message,
                `<b>Premium 统计</b>\nPremium：<b>${premium}</b> / ${users}（<b>${percent}%</b>）\n过滤 Bot ${bots} · 已注销 ${deleted}\n处理成员 ${processed}${limited}`,
                { parseMode: "html" },
              );
              signal.throwIfAborted();
            });
          } catch (error) {
            if (context.signal.aborted) return;
            context.log.error("premium_scan_failed");
            await context.telegram.edit(invocation.message, `<b>统计失败</b>\n${failure(error)}`, {
              parseMode: "html",
            });
          }
        },
      },
    },
  });
}
