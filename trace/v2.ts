import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, type SubcommandDefinition, definePlugin, type PluginContext, type MessageEnvelope} from "telebox/sdk";
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
const guarded = (operation: CommandDefinition["handle"]): CommandDefinition["handle"] => async (invocation, ctx) => {
  try { await operation(invocation, ctx); }
  catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "自动回应操作失败，请检查参数、会员状态或会话权限"); }
};
const clear = (reset: boolean): SubcommandDefinition => ({description: reset ? "重置全部数据和配置" : "清空用户与关键词追踪，保留配置", args: "", handle: guarded(async (i, ctx) => {
  await store(ctx).update(data => reset ? defaults() : {...data, users: {}, keywords: {}});
  await receipt(ctx, i.message, reset ? "自动回应已重置" : "追踪已清空");
})});
const setting = (key: "keepLog" | "big"): SubcommandDefinition => ({
  description: key === "keepLog" ? "设置是否保留操作回执，默认 true" : "设置大号动画，默认 true", args: "true|false",
  handle: guarded(async (i, ctx) => {
    const action = i.args[0]; if (action !== "true" && action !== "false") throw new Error("请使用 true 或 false");
    await store(ctx).update(data => ({...data, config: {...data.config, [key]: action === "true"}}));
    await receipt(ctx, i.message, "自动回应配置已更新");
  }),
});
const keyword = (adding: boolean): CommandDefinition["handle"] => guarded(async (i, ctx) => {
  const word = i.args[0]; if (!word) throw new Error("请提供关键词及 add/del 操作");
  const items = adding ? await parse(i.message, i.args.slice(1).join(" "), ctx) : [];
  if (adding && !items.length) throw new Error("未找到有效表情");
  await store(ctx).update(data => {
    const keywords = {...data.keywords}; if (adding) keywords[word] = items; else delete keywords[word];
    return {...data, keywords};
  });
  await receipt(ctx, i.message, "关键词追踪已更新");
});
const command: CommandDefinition = {
  description: "管理自动回应", helpArgs: ["help", "h"], args: "[表情]", subcommandsCaseSensitive: true,
  examples: [{args: "👍👎🥰", description: "回复消息，追踪发送者并立即回应"}, {args: "", description: "回复消息，取消追踪该用户"}],
  subcommands: {
    status: {description: "查看用户、关键词数量和配置", args: "", handle: guarded(async (i, ctx) => {
      const data = await store(ctx).read();
      await ctx.telegram.edit(i.message, `自动回应\n用户: ${Object.keys(data.users).length}\n关键词: ${Object.keys(data.keywords).length}\n保留回执: ${data.config.keepLog}\n大号动画: ${data.config.big}`);
    })},
    clean: clear(false), reset: clear(true), log: setting("keepLog"), big: setting("big"),
    kw: {description: "管理关键词追踪", subcommands: {
      add: {description: "为关键词设置自动回应", args: "关键词 表情", examples: [{args: "add 开心 👍🥰"}], handle: keyword(true)},
      del: {description: "删除关键词追踪", args: "关键词", examples: [{args: "del 开心"}], handle: keyword(false)},
    }, handle: guarded(async () => { throw new Error("请提供关键词及 add/del 操作"); })},
  },
  help: [{heading: "匹配与回执：", body: "接收消息时优先匹配用户，其次匹配第一个包含的关键词；忽略发出消息和收藏夹。log false 时约 10 秒后删除操作回执。"},
    {heading: "表情与会员：", body: "标准表情无需 Premium，自定义表情需要 Premium。支持的标准表情：<code>" + [...standard].join("") + "</code>。"}],
  handle: guarded(async (invocation, ctx) => {
    const sub = invocation.args[0], db = store(ctx);
    if (sub === "help" || sub === "h") { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
        const reply = await ctx.telegram.getReply(invocation.message);
        if (!reply?.senderId) {await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return;}
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
  }),
};
const help = (prefix: string) => renderCommandHelp("trace", command, {prefix, title: "🎯 自动回应"});
export default function createTrace() {
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "trace", description: "用户与关键词自动回应", commands: {trace: command},
    listeners: [{direction: "incoming",
    async handle(message, ctx) {
      if (!message.senderId || message.saved) return;
      const data = await store(ctx).read();
      const items = data.users[message.senderId] ??
        Object.entries(data.keywords).find(([keyword]) => message.text.includes(keyword))?.[1];
      if (!items?.length) return;
      try {await sendReactions(ctx, message, normalize(items), data.config.big);}
      catch {if (!ctx.signal.aborted) ctx.log.error("trace.reaction_failed");}
    },
  }]});
}
