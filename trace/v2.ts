import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext, type MessageEnvelope} from "telebox/sdk";
import {Api} from "teleproto";
import {returnBigInt} from "teleproto/Helpers";
import {setTimeout as delay} from "node:timers/promises";
import {sendReactions, type Reaction} from "./v2/reactions";

type Stored = Reaction | string;
type Data = {users: Record<string, Stored[]>; keywords: Record<string, Stored[]>; config: {keepLog: boolean; big: boolean}};
const defaults = (): Data => ({users: {}, keywords: {}, config: {keepLog: true, big: true}});
const store = (ctx: PluginContext) => ctx.storage.json<Data>("db.json", defaults());
const standard = new Set<string>();
const emojiSegments = new Intl.Segmenter(undefined, {granularity: "grapheme"});
for (const {segment} of emojiSegments.segment("👍👎❤️🔥🥰👏😁🤔🤯😱🤬😢🎉🤩🤮💩🙏👌🕊🤡🥱🥴😍🐳❤️‍🔥🌚🌭💯🤣⚡️🍌🏆💔🤨😐🍓🍾💋🖕😈😎😇😤")) standard.add(segment);
const help = "<b>自动回应</b>\n回复消息：<code>trace 表情</code> 追踪，<code>trace</code> 取消\n<code>trace kw add 关键词 表情</code>\n<code>trace kw del 关键词</code>\n<code>trace status</code> · <code>trace clean</code> · <code>trace reset</code>\n<code>trace log true/false</code> · <code>trace big true/false</code>";
function normalize(items: Stored[]): Reaction[] {
  return items.map(item => typeof item === "string" ?
    (/^[1-9]\d*$/.test(item) ? {documentId: item} : {emoticon: item}) : item);
}
async function parse(message: MessageEnvelope, text: string, ctx: PluginContext): Promise<Reaction[]> {
  const offset = message.text.lastIndexOf(text);
  const raw = message.raw as {entities?: Api.TypeMessageEntity[]} | undefined;
  const custom = (raw?.entities ?? []).filter((entity): entity is Api.MessageEntityCustomEmoji =>
    entity instanceof Api.MessageEntityCustomEmoji && entity.offset >= offset && entity.offset + entity.length <= offset + text.length);
  if (custom.length) {
    const premium = await ctx.telegram.withClient(async (client, signal) => {
      const me = await client.getMe(); signal.throwIfAborted(); return me.premium;
    });
    if (!premium) throw new Error("自定义表情需要 Premium");
  }
  const found: Reaction[] = [];
  for (const {segment, index} of emojiSegments.segment(text)) {
    const entity = custom.find(item => item.offset === offset + index);
    if (entity) found.push({documentId: entity.documentId.toString()});
    else if (!custom.some(item => offset + index >= item.offset && offset + index < item.offset + item.length) && standard.has(segment)) found.push({emoticon: segment});
  }
  return [...new Map(found.map(item => [JSON.stringify(item), item])).values()];
}
async function receipt(ctx: PluginContext, message: MessageEnvelope, text: string) {
  await ctx.telegram.edit(message, text);
  if ((await store(ctx).read()).config.keepLog) return;
  void ctx.tasks.run("trace:receipt", async signal => {
    await delay(10000, undefined, {signal});
    await ctx.telegram.withClient(async (client, active) => {
      active.throwIfAborted();
      const raw = message.raw as {peerId?: Api.TypePeer} | undefined;
      await client.deleteMessages(raw?.peerId ?? returnBigInt(message.chatId), [message.id], {revoke: true});
    });
  }).catch(() => {if (!ctx.signal.aborted) ctx.log.error("trace.receipt_delete_failed");});
}
export default function createTrace() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "trace", description: "用户与关键词自动回应", commands: {
    trace: {helpArgs: ["help","h"], description: "管理自动回应", async handle(invocation, ctx) {
      const [sub, action, keyword] = invocation.args;
      const db = store(ctx);
      try {
        if (sub === "help" || sub === "h") {await ctx.telegram.edit(invocation.message, help, {parseMode: "html"}); return;}
        if (sub === "status") {
          const data = await db.read();
          await ctx.telegram.edit(invocation.message, `自动回应\n用户: ${Object.keys(data.users).length}\n关键词: ${Object.keys(data.keywords).length}\n保留回执: ${data.config.keepLog}\n大号动画: ${data.config.big}`);
          return;
        }
        if (sub === "clean" || sub === "reset") {
          await db.update(data => sub === "reset" ? defaults() : {...data, users: {}, keywords: {}});
          await receipt(ctx, invocation.message, sub === "reset" ? "自动回应已重置" : "追踪已清空"); return;
        }
        if (sub === "log" || sub === "big") {
          if (action !== "true" && action !== "false") throw new Error("请使用 true 或 false");
          await db.update(data => ({...data, config: {...data.config, [sub === "log" ? "keepLog" : "big"]: action === "true"}}));
          await receipt(ctx, invocation.message, "自动回应配置已更新"); return;
        }
        if (sub === "kw") {
          if (!keyword || !["add", "del"].includes(action)) throw new Error("请提供关键词及 add/del 操作");
          const items = action === "add" ? await parse(invocation.message, invocation.args.slice(3).join(" "), ctx) : [];
          if (action === "add" && !items.length) throw new Error("未找到有效表情");
          await db.update(data => {
            const keywords = {...data.keywords};
            if (action === "add") keywords[keyword] = items; else delete keywords[keyword];
            return {...data, keywords};
          });
          await receipt(ctx, invocation.message, "关键词追踪已更新"); return;
        }
        const reply = await ctx.telegram.getReply(invocation.message);
        if (!reply?.senderId) {await ctx.telegram.edit(invocation.message, help, {parseMode: "html"}); return;}
        const id = reply.senderId;
        const items = sub ? await parse(invocation.message, invocation.args.join(" "), ctx) : [];
        if (sub && !items.length) throw new Error("未找到有效表情");
        await db.update(data => {
          const users = {...data.users};
          if (sub) users[id] = items; else delete users[id];
          return {...data, users};
        });
        if (sub) await sendReactions(ctx, reply, items, (await db.read()).config.big);
        await receipt(ctx, invocation.message, sub ? `已追踪用户 ${id}` : `已取消追踪 ${id}`);
      } catch {if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "自动回应操作失败，请检查参数、会员状态或会话权限");}
    }},
  }, listeners: [{
    async handle(message, ctx) {
      if (!message.senderId || message.outgoing || message.saved) return;
      const data = await store(ctx).read();
      const items = data.users[message.senderId] ??
        Object.entries(data.keywords).find(([keyword]) => message.text.includes(keyword))?.[1];
      if (!items?.length) return;
      try {await sendReactions(ctx, message, normalize(items), data.config.big);}
      catch {if (!ctx.signal.aborted) ctx.log.error("trace.reaction_failed");}
    },
  }]});
}
