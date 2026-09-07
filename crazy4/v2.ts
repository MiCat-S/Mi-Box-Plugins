import {definePlugin} from "telebox/sdk";
import type {Api} from "teleproto";
import {crazy4Data} from "./v2/data";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

export default function createCrazy4() {
  return definePlugin({apiVersion: 1, id: "crazy4", description: "随机发送疯狂星期四文案",
    commands: {crazy4: {description: "随机发送疯狂星期四文案", async handle(invocation, context) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
        await context.telegram.edit(invocation.message, `<b>疯狂星期四</b>\n<code>${escape(invocation.prefix)}crazy4</code> 随机发送一条文案`, {parseMode: "html"});
        return;
      }
      const text = crazy4Data[Math.floor(Math.random() * crazy4Data.length)];
      if (!text) {
        await context.telegram.edit(invocation.message, "文案库为空");
        return;
      }
      try {
        await context.telegram.withClient(async client => {
          const raw = invocation.message.raw as Api.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          await client.sendMessage(raw.peerId, {message: escape(text), parseMode: "html", replyTo: invocation.message.replyToId});
          if (typeof raw.delete === "function") await raw.delete({revoke: true});
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("crazy4_failed");
        await context.telegram.edit(invocation.message, "文案发送失败，请稍后重试");
      }
    }}},
  });
}
