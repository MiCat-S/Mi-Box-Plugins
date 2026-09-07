import {setTimeout as delay} from "node:timers/promises";
import {definePlugin} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

export default function createRestorePin() {
  return definePlugin({apiVersion: 1, id: "restore_pin", description: "从管理员日志恢复最近取消的置顶消息",
    commands: {restore_pin: {description: "恢复最近取消的置顶消息", async handle(invocation, context) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
        await context.telegram.edit(invocation.message, `<b>恢复置顶</b>\n<code>${invocation.prefix}restore_pin</code>\n仅支持拥有管理员权限的超级群组和频道。`, {parseMode: "html"});
        return;
      }
      try {
        await context.telegram.edit(invocation.message, "正在读取管理员日志…");
        await context.telegram.withClient(async (client, signal) => {
          const {Api} = await import("teleproto");
          const {returnBigInt} = await import("teleproto/Helpers.js");
          const raw = invocation.message.raw as ApiTypes.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          const chat = await client.getEntity(raw.peerId);
          if (!(chat instanceof Api.Channel)) throw new Error("Unsupported chat");
          const me = await client.getMe();
          const membership = await client.invoke(new Api.channels.GetParticipant({channel: chat, participant: me}));
          if (!(membership.participant instanceof Api.ChannelParticipantAdmin) &&
              !(membership.participant instanceof Api.ChannelParticipantCreator)) throw new Error("Admin required");
          const log = await client.invoke(new Api.channels.GetAdminLog({
            channel: chat, q: "", maxId: returnBigInt(0), minId: returnBigInt(0), limit: 100,
            eventsFilter: new Api.ChannelAdminLogEventsFilter({pinned: true}),
          }));
          const ids = [...new Set(log.events.flatMap(event => {
            if (!(event.action instanceof Api.ChannelAdminLogEventActionUpdatePinned)) return [];
            const message = event.action.message;
            return message instanceof Api.Message && !message.pinned ? [message.id] : [];
          }))];
          if (!ids.length) {
            await context.telegram.edit(invocation.message, "没有找到可恢复的置顶消息");
            return;
          }
          let succeeded = 0;
          for (let index = 0; index < ids.length; index++) {
            signal.throwIfAborted();
            try {
              await client.invoke(new Api.messages.UpdatePinnedMessage({peer: chat, id: ids[index]!, silent: true, unpin: false}));
              succeeded++;
            } catch { context.log.error("restore_pin_item_failed"); }
            if ((index + 1) % 3 === 0) await context.telegram.edit(invocation.message, `正在恢复置顶… ${index + 1}/${ids.length}`);
            if (index + 1 < ids.length) await delay(1000, undefined, {signal});
          }
          await context.telegram.edit(invocation.message,
            `<b>恢复置顶完成</b>\n成功 ${succeeded} · 失败 ${ids.length - succeeded} · 总计 ${ids.length}`,
            {parseMode: "html"});
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("restore_pin_failed");
        await context.telegram.edit(invocation.message, "恢复置顶失败，请确认当前账号拥有管理员权限");
      }
    }}},
  });
}
