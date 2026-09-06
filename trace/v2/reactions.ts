import {Api} from "teleproto";
import {returnBigInt} from "teleproto/Helpers";
import type {MessageEnvelope, PluginContext} from "telebox/sdk";

export type Reaction = {emoticon: string} | {documentId: string};

export async function sendReactions(
  ctx: PluginContext, message: MessageEnvelope, reactions: readonly Reaction[], big: boolean,
): Promise<void> {
  if (!reactions.length) return;
  const values = reactions.map(reaction => {
    if ("emoticon" in reaction) {
      if (!reaction.emoticon.trim()) throw new Error("表情不能为空");
      return new Api.ReactionEmoji({emoticon: reaction.emoticon});
    }
    if (!/^[1-9]\d*$/.test(reaction.documentId) || BigInt(reaction.documentId) > 9223372036854775807n) {
      throw new Error("自定义表情 ID 无效");
    }
    return new Api.ReactionCustomEmoji({documentId: returnBigInt(reaction.documentId)});
  });
  await ctx.telegram.withClient(async (client, signal) => {
    signal.throwIfAborted();
    const raw = message.raw as {peerId?: Api.TypePeer} | undefined;
    const target = raw?.peerId ?? returnBigInt(message.chatId);
    const peer = await client.getInputEntity(target);
    signal.throwIfAborted();
    await client.invoke(new Api.messages.SendReaction({
      peer, msgId: message.id, reaction: values, big,
    }));
  });
}
