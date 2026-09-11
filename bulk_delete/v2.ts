import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";

type Data = {schemaVersion: 1; userDeleteMode: Record<string, boolean>};
const store = (ctx: PluginContext) => ctx.storage.json<Data>("bulk_delete_config.json", {schemaVersion: 1, userDeleteMode: {}});
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(done, ms);
  function done() { signal.removeEventListener("abort", abort); resolve(); }
  function abort() { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); }
  signal.addEventListener("abort", abort, {once: true});
});

async function removeLater(ctx: PluginContext, chat: any, ids: number[], ms: number) {
  void ctx.tasks.run(`bd:cleanup:${chat}:${ids.join(",")}`, async signal => {
    await sleep(ms, signal);
    await ctx.telegram.withClient(client => client.deleteMessages(chat, ids, {revoke: true}));
  }).catch(() => undefined);
}

async function handle(message: MessageEnvelope, args: readonly string[], ctx: PluginContext) {
  await ctx.telegram.withClient(async (client: any, signal) => {
    const raw: any = message.raw;
    const chat: any = raw?.chatId ?? raw?.peerId ?? message.chatId;
    const me = await client.getMe();
    const userId = String(me.id);
    const sub = args[0]?.toLowerCase();
    if (sub === "on" || sub === "off") {
      await store(ctx).update(data => ({...data, schemaVersion: 1, userDeleteMode: {...data.userDeleteMode, [userId]: sub === "on"}}), signal);
      const sent = await client.sendMessage(chat, {message: `✅ 已${sub === "on" ? "开启" : "关闭"}删除他人消息权限。`});
      await removeLater(ctx, chat, [sent.id, message.id], 2000);
      return;
    }
    const data = await store(ctx).read(signal);
    const configured = data.userDeleteMode[userId] !== false;
    if (!message.replyToId) {
      const number = Number(sub);
      if (Number.isInteger(number) && number > 0 && number <= 99) {
        const recent: any[] = await client.getMessages(chat, {limit: 100});
        const own = recent.filter(item => item.id !== message.id && String(item.senderId ?? "") === userId).slice(0, number);
        await client.deleteMessages(chat, [message.id, ...own.map(item => item.id)], {revoke: true});
        if (own.length) {
          const sent = await client.sendMessage(chat, {message: `✅ 成功删除您最近的 ${own.length} 条消息。`});
          await removeLater(ctx, chat, [sent.id], 2000);
        }
        return;
      }
      const sent = await client.sendMessage(chat, {message: `⚠️ 请回复一条消息以确定删除范围，或使用 \`${message.text.split(/\s/)[0]} <数字>\` 删除您最近的消息。\n💡 当前删除他人权限: ${configured ? "开启" : "关闭"} (${message.text.split(/\s/)[0]} on/off 切换)`});
      await removeLater(ctx, chat, [sent.id, message.id], 3000);
      return;
    }
    let admin = false;
    try {
      const entity: any = await client.getEntity(chat);
      if (entity?.className !== "Channel" && entity?.className !== "Chat") admin = true;
      else {
        const {Api} = await import("teleproto");
        const result: any = await client.invoke(new Api.channels.GetParticipant({channel: chat, participant: new Api.InputPeerSelf()}));
        const participant = result?.participant;
        admin = participant?.className === "ChannelParticipantCreator" ||
          (participant?.className === "ChannelParticipantAdmin" && !!participant.adminRights?.deleteMessages);
      }
    } catch { admin = false; }
    let messages: any[];
    try { messages = await client.getMessages(chat, {minId: message.replyToId - 1, maxId: message.id + 1, limit: 100}); }
    catch {
      const sent = await client.sendMessage(chat, {message: "❌ 收集消息列表时出错。"});
      await removeLater(ctx, chat, [sent.id, message.id], 3000); return;
    }
    const canDeleteOthers = configured && admin;
    const selected = messages.filter(item => item.id >= message.replyToId! && item.id <= message.id &&
      (canDeleteOthers || String(item.senderId ?? "") === userId));
    if (selected.some(item => item.id !== message.id)) {
      await client.deleteMessages(chat, selected.map(item => item.id), {revoke: true});
    } else {
      const sent = await client.sendMessage(chat, {message: `🚫 您没有删除该范围内消息的权限。${configured ? "" : "\n💡 当前处于'仅删除自己消息'模式，使用 .bd on 开启删除他人权限"}`, replyTo: message.replyToId});
      await removeLater(ctx, chat, [sent.id, message.id], 3000);
    }
  });
}

export default function createBulkDelete() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "bulk_delete", description: "回复消息后批量删除范围消息；bd <数字> 删除自己的最近消息；bd on/off 控制是否删除他人消息", commands: {
    bd: {helpArgs: ["help", "h"], description: "批量删除消息", async handle({message, args}, ctx) { await handle(message, args, ctx); }},
  }});
}
