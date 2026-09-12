import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition} from "telebox/sdk";
import type {Api} from "teleproto";
import {crazy4Data} from "./v2/data";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

const crazy4Command: CommandDefinition = {
  description: "随机发送疯狂星期四文案",
  helpArgs: ["help", "h"],
  args: "",
  examples: [{args: "", description: "随机发送一条疯狂星期四文案"}],
  help: [{heading: "说明：", body: "从内置文案库随机抽取一条发送到当前对话。"}],
  async handle(invocation, context) {
    if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
      await context.telegram.edit(invocation.message, renderCommandHelp("crazy4", crazy4Command, {prefix: invocation.prefix}), {parseMode: "html"});
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
        if (typeof raw.delete === "function") { try { await raw.delete({revoke: true}); }
          catch { if (!context.signal.aborted) context.log.info("crazy4_receipt_cleanup_failed"); } }
      });
    } catch {
      if (context.signal.aborted) return;
      context.log.error("crazy4_failed");
      await context.telegram.edit(invocation.message, "文案发送失败，请稍后重试");
    }
  },
};

export default function createCrazy4() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "crazy4", description: "随机发送疯狂星期四文案",
    renderHelp: prefix => renderCommandHelp("crazy4", crazy4Command, {prefix, title: "🍗 疯狂星期四插件"}),
    commands: {crazy4: crazy4Command}});
}
