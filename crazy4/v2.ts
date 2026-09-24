import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin } from "telebox/sdk";
import type { Api } from "teleproto";
import { returnBigInt } from "teleproto/Helpers";
import { crazy4Data } from "./v2/data";

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>\"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );

export default function createCrazy4() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "crazy4",
    description: "随机发送疯狂星期四文案",
    commands: {
      crazy4: {
        helpArgs: ["help", "h"],
        description: "随机发送疯狂星期四文案",
        async handle(invocation, context) {
          if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
            await context.telegram.edit(
              invocation.message,
              `<b>疯狂星期四</b>\n<code>${escape(invocation.prefix)}crazy4</code> 随机发送一条文案`,
              { parseMode: "html" },
            );
            return;
          }
          const text = crazy4Data[Math.floor(Math.random() * crazy4Data.length)];
          if (!text) {
            await context.telegram.edit(invocation.message, "文案库为空");
            return;
          }
          try {
            await context.telegram.withClient(async (client, signal) => {
              const raw = invocation.message.raw as Api.Message | undefined;
              const peer = raw?.peerId ?? returnBigInt(invocation.message.chatId);
              signal.throwIfAborted();
              await client.sendMessage(peer, {
                message: escape(text),
                parseMode: "html",
                replyTo: invocation.message.replyToId,
              });
              signal.throwIfAborted();
              try {
                if (typeof raw?.delete === "function") await raw.delete({ revoke: true });
                else await client.deleteMessages(peer, [invocation.message.id], { revoke: true });
              } catch {
                signal.throwIfAborted();
                context.log.error("crazy4_receipt_cleanup_failed", {
                  chatId: invocation.message.chatId,
                  messageId: invocation.message.id,
                });
              }
            });
          } catch {
            if (context.signal.aborted) return;
            context.log.error("crazy4_failed", { chatId: invocation.message.chatId, messageId: invocation.message.id });
            await context.telegram.edit(invocation.message, "文案发送失败，请稍后重试");
          }
        },
      },
    },
  });
}
