import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin} from "telebox/sdk";
import {Api, type TelegramClient} from "teleproto";
import {RPCError} from "teleproto/errors";

function isForwardRestricted(error: unknown): error is RPCError {
  return error instanceof RPCError && error.errorMessage === "CHAT_FORWARDS_RESTRICTED";
}

async function copyMessage(client: TelegramClient, peer: Api.TypeEntityLike, message: Api.Message, topicId?: number): Promise<void> {
  const formattingEntities = message.entities?.length ? message.entities : undefined;
  if (message.media) {
    await client.sendFile(peer, {file: message.media, caption: message.message || "", formattingEntities,
      ...(topicId ? {replyTo: topicId} : {})});
  } else if (message.message) {
    await client.sendMessage(peer, {message: message.message, formattingEntities,
      ...(topicId ? {replyTo: topicId} : {})});
  }
}

export default function createRe() {
  const command: CommandDefinition = {
    description: "回复消息后复读，可指定数量和次数",
    args: "[消息数] [复读次数]",
    arguments: [
      {name: "消息数", description: "默认 1，范围 1–20；截至被回复消息的若干条消息"},
      {name: "复读次数", description: "默认 1，范围 1–10"},
    ],
    examples: [{args: "", description: "回复消息复读一条、一次"}, {args: "3"}, {args: "3 2"}],
    help: [{heading: "复读范围与条件：", body: "先回复目标消息，再发送命令；读取截至被回复消息的最近若干条消息，并发送到当前对话。成功后删除命令消息。"},
      {heading: "受限消息：", body: "来源不允许转发时会自动复制文字、媒体及原有文字格式；论坛话题内仍发送到当前话题。"}],
    async handle(invocation, ctx) {
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
          const messages = (await client.getMessages(source!, {offsetId: reply.id - 1, limit: count, reverse: true}))
            .filter((message): message is Api.Message => message instanceof Api.Message);
          if (!messages.length) throw new Error("source messages unavailable");
          const ids = messages.map(message => message.id);
          const topicId = invocation.message.topicId ?? raw.replyTo?.replyToTopId ?? raw.replyTo?.replyToMsgId;
          let forwardRestricted = false;
          for (let index = 0; index < repeat; index++) {
            try {
              await client.invoke(new Api.messages.ForwardMessages({fromPeer: source!, id: ids, toPeer: target!,
                ...(topicId ? {topMsgId: topicId} : {})}));
            } catch (error) {
              if (!isForwardRestricted(error)) throw error;
              forwardRestricted = true;
              break;
            }
          }
          if (forwardRestricted) {
            for (let index = 0; index < repeat; index++) {
              for (const message of messages) await copyMessage(client, target!, message, topicId);
            }
          }
          const command = invocation.message.raw as {delete?: () => Promise<unknown>};
          if (typeof command.delete === "function") {
            try { await command.delete(); }
            catch { ctx.log.error("re_command_cleanup_failed"); }
          }
        });
      } catch {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "复读失败，请稍后重试");
      }
    }};
  const help = (prefix: string) => renderCommandHelp("re", command, {prefix, title: "🔁 消息复读"});
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "re", description: "复读回复的消息",
    commands: {re: command},
  });
}
