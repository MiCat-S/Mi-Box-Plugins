import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin} from "telebox/sdk";
import type {Api} from "teleproto";

export default function createRe() {
  const command: CommandDefinition = {"args":"[消息数] [复读次数]","arguments":[{"name":"消息数","description":"默认 1，范围 1–20；截至被回复消息的若干条消息"},{"name":"复读次数","description":"默认 1，范围 1–10"}],"examples":[{"args":"","description":"回复消息转发一条、一次"},{"args":"3"},{"args":"3 2"}],"help":[{"heading":"条件：","body":"目标消息需要允许转发，成功后删除命令消息。"}],description: "回复消息后重复转发，可指定数量和次数", async handle(invocation, ctx) {
      const reply = await ctx.telegram.getReply(invocation.message);
      const raw = reply?.raw as Api.Message | undefined;
      const count = Math.min(Math.max(Number(invocation.args[0]) || 1, 1), 20);
      const repeat = Math.min(Math.max(Number(invocation.args[1]) || 1, 1), 10);
      if (!raw || !reply) {
        await ctx.telegram.edit(invocation.message, "请回复一条消息使用 .re [消息数] [复读次数]");
        return;
      }
      try {
        await ctx.telegram.withClient(async client => {
          const source = await raw.getInputChat();
          const target = await (invocation.message.raw as Api.Message).getInputChat();
          if (!target) throw new Error("target unavailable");
          const ids = Array.from({length: count}, (_, index) => reply.id - count + index + 1).filter(id => id > 0);
          for (let index = 0; index < repeat; index++) {
            await client.forwardMessages(target!, {messages: ids, fromPeer: source!});
          }
          const command = invocation.message.raw as {delete?: () => Promise<unknown>};
          if (typeof command.delete === "function") await command.delete();
        });
      } catch {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "复读失败：目标消息可能禁止转发");
      }
    }};
  const help = (prefix: string) => renderCommandHelp("re", command, {prefix, title: "🔁 消息复读"});
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "re", description: "复读回复的消息",
    commands: {re: command},
  });
}
