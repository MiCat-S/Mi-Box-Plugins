import { renderHelp as renderPluginHelp } from "./v2/help";
import { setTimeout as delay } from "node:timers/promises";
import { definePlugin, type PluginContext } from "telebox/sdk";
import { Api, helpers, utils } from "teleproto";
type Pause = (signal: AbortSignal) => Promise<void>;
const pause: Pause = signal => delay(1000, undefined, { signal });
function peer(chatId: string): Api.TypePeer {
  const [id, Peer] = utils.resolveId(helpers.returnBigInt(chatId));
  if (Peer === Api.PeerUser) return new Api.PeerUser({ userId: id });
  if (Peer === Api.PeerChat) return new Api.PeerChat({ chatId: id });
  return new Api.PeerChannel({ channelId: id });
}
export function unpinnedIds(log: Api.channels.AdminLogResults): number[] {
  const ids: number[] = [];
  for (const event of log.events) {
    if (!(event.action instanceof Api.ChannelAdminLogEventActionUpdatePinned)) continue;
    const message = event.action.message;
    if (!(message instanceof Api.MessageEmpty) && !message.pinned && Number.isSafeInteger(message.id) && message.id > 0)
      ids.push(message.id);
  }
  return [...new Set(ids)];
}
function failure(error: unknown): string {
  if (!error || typeof error !== "object") return "❌ 操作失败，请稍后重试";
  const values = [
      Object.getOwnPropertyDescriptor(error, "errorMessage")?.value,
      Object.getOwnPropertyDescriptor(error, "message")?.value,
    ].filter(v => typeof v === "string") as string[],
    text = values.join(" ");
  if (text.includes("CHAT_ADMIN_REQUIRED")) return "❌ 需要管理员权限";
  if (text.includes("USER_NOT_PARTICIPANT")) return "❌ 用户不是群组成员";
  if (text.includes("AUTH_KEY_UNREGISTERED")) return "❌ 会话已失效，请重新登录";
  return "❌ 操作失败，请稍后重试";
}
export default function createRestorePin(options: { pause?: Pause } = {}) {
  const wait = options.pause ?? pause;
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "restore_pin",
    description: "从管理员日志恢复最近取消的置顶消息",
    commands: {
      restore_pin: {
        helpArgs: ["help", "h"],
        description: "恢复最近取消的置顶消息",
        async handle(invocation, context) {
          if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
            await context.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), { parseMode: "html" });
            return;
          }
          try {
            await context.telegram.edit(invocation.message, "📋 正在获取管理员日志...", { parseMode: "html" });
            context.signal.throwIfAborted();
            await context.telegram.withClient(async (client, clientSignal) => {
              const signal = AbortSignal.any([context.signal, clientSignal]);
              signal.throwIfAborted();
              const raw = invocation.message.raw as Api.Message | undefined,
                target = raw?.peerId ?? peer(invocation.message.chatId),
                chat = await client.getEntity(target);
              signal.throwIfAborted();
              if (!(chat instanceof Api.Channel)) throw new Error("UNSUPPORTED_CHAT");
              const membership = await client.invoke(
                new Api.channels.GetParticipant({ channel: chat, participant: new Api.InputPeerSelf() }),
              );
              signal.throwIfAborted();
              if (
                !(membership.participant instanceof Api.ChannelParticipantAdmin) &&
                !(membership.participant instanceof Api.ChannelParticipantCreator)
              )
                throw new Error("CHAT_ADMIN_REQUIRED");
              const log = await client.invoke(
                new Api.channels.GetAdminLog({
                  channel: chat,
                  q: "",
                  maxId: helpers.returnBigInt(0),
                  minId: helpers.returnBigInt(0),
                  limit: 100,
                  eventsFilter: new Api.ChannelAdminLogEventsFilter({ pinned: true }),
                }),
              );
              signal.throwIfAborted();
              const ids = unpinnedIds(log);
              if (!ids.length) {
                await context.telegram.edit(invocation.message, "✅ 未找到可恢复的置顶消息", { parseMode: "html" });
                signal.throwIfAborted();
                return;
              }
              await context.telegram.edit(
                invocation.message,
                `🔍 找到 ${ids.length} 条可恢复的置顶消息，开始自动恢复...`,
                { parseMode: "html" },
              );
              signal.throwIfAborted();
              await context.telegram.edit(invocation.message, `🔄 正在恢复 ${ids.length} 条置顶消息...`, {
                parseMode: "html",
              });
              signal.throwIfAborted();
              let succeeded = 0,
                failed = 0;
              const failedIds: number[] = [];
              for (const [index, id] of ids.entries()) {
                signal.throwIfAborted();
                if ((index + 1) % 3 === 0) {
                  await context.telegram.edit(
                    invocation.message,
                    `🔄 正在恢复第 ${index + 1}/${ids.length} 条置顶消息...\n✅ 成功: ${succeeded} ❌ 失败: ${failed}`,
                    { parseMode: "html" },
                  );
                  signal.throwIfAborted();
                }
                try {
                  await client.invoke(
                    new Api.messages.UpdatePinnedMessage({ peer: chat, id, silent: true, unpin: false }),
                  );
                  signal.throwIfAborted();
                  succeeded++;
                } catch {
                  signal.throwIfAborted();
                  failed++;
                  failedIds.push(id);
                  context.log.error("restore_pin_item_failed");
                }
                await wait(signal);
                signal.throwIfAborted();
              }
              let result = `📊 <b>恢复完成</b>\n\n✅ 成功恢复: ${succeeded} 条\n❌ 恢复失败: ${failed} 条`;
              if (failedIds.length) {
                result +=
                  "\n\n<b>失败详情：</b>\n" +
                  failedIds
                    .slice(0, 3)
                    .map(id => `• 消息 ${id} 恢复失败`)
                    .join("\n");
                if (failedIds.length > 3) result += `\n• ... 还有 ${failedIds.length - 3} 个错误`;
              }
              try {
                await context.telegram.edit(invocation.message, result, { parseMode: "html" });
                signal.throwIfAborted();
              } catch {
                signal.throwIfAborted();
                context.log.error("restore_pin_receipt_failed");
              }
            });
          } catch (error) {
            if (context.signal.aborted) return;
            context.log.error("restore_pin_failed");
            await context.telegram.edit(invocation.message, failure(error), { parseMode: "html" });
          }
        },
      },
    },
  });
}
