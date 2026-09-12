import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type PluginContext, type SubcommandDefinition} from "telebox/sdk";

type Data = {schemaVersion: 1; userDeleteMode: Record<string, boolean>};
const store = (ctx: PluginContext) => ctx.storage.json<Data>("bulk_delete_config.json", {schemaVersion: 1, userDeleteMode: {}});
export const managedDelay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const done = (): void => { signal.removeEventListener("abort", abort); resolve(); };
  const abort = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", abort, {once: true});
});

async function removeLater(ctx: PluginContext, chat: any, ids: number[], ms: number) {
  void ctx.tasks.run(`bd:cleanup:${chat}:${ids.join(",")}`, async signal => {
    await managedDelay(ms, signal);
    await ctx.telegram.withClient(client => client.deleteMessages(chat, ids, {revoke: true}));
  }).catch(() => undefined);
}

const mode = (enabled: boolean): SubcommandDefinition => ({
  description: enabled ? "开启删除他人消息权限" : "关闭删除他人消息权限",
  args: "", examples: [{args: enabled ? "on" : "off"}],
  handle: async (invocation, ctx) => {
    await ctx.telegram.withClient(async (client: any, signal) => {
      const raw: any = invocation.message.raw;
      const chat: any = raw?.chatId ?? raw?.peerId ?? invocation.message.chatId;
      const me = await client.getMe();
      const userId = String(me.id);
      await store(ctx).update(data => ({...data, schemaVersion: 1, userDeleteMode: {...data.userDeleteMode, [userId]: enabled}}), signal);
      const sent = await client.sendMessage(chat, {message: `✅ 已${enabled ? "开启" : "关闭"}删除他人消息权限。`});
      await removeLater(ctx, chat, [sent.id, invocation.message.id], 2000);
    });
  },
});

const bdCommand: CommandDefinition = {
  description: "批量删除消息",
  helpArgs: ["help", "h"],
  args: "[数字|on|off]",
  arguments: [{name: "数字", description: "删除自己最近 1–99 条消息；需回复范围时直接发送 .bd 回复消息"}],
  examples: [{args: "20"}, {args: "on"}, {args: "off"}],
  subcommandsCaseSensitive: false,
  subcommands: {on: mode(true), off: mode(false)},
  help: [
    {heading: "说明：", body: "回复一条消息后发送 <code>{prefix}bd</code> 删除与之之间的范围消息；<code>{prefix}bd on</code> / <code>{prefix}bd off</code> 切换是否允许删除他人消息。"},
    {heading: "范围与权限：", body: "数量模式从当前对话最近 100 条消息中筛选自己的消息，按倒序取前 N 条删除；回复范围模式每次最多获取 100 条消息。删除他人消息开关默认开启，按当前登录账号保存；on 只控制插件选择范围，群组中仍需群主或管理员删除消息权限，删除以撤回方式执行。"},
  ],
  async handle(invocation, ctx) {
    await ctx.telegram.withClient(async (client: any, signal) => {
      const message = invocation.message;
      const args = invocation.args;
      const raw: any = message.raw;
      const chat: any = raw?.chatId ?? raw?.peerId ?? message.chatId;
      const me = await client.getMe();
      const userId = String(me.id);
      const sub = args[0]?.toLowerCase();
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
          const result: any = await client.invoke(new Api.channels.GetParticipant({channel: chat, participant: me.id}));
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
  },
};

export default function createBulkDelete() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "bulk_delete", description: "回复消息后批量删除范围消息；bd <数字> 删除自己的最近消息；bd on/off 控制是否删除他人消息",
    renderHelp: prefix => renderCommandHelp("bd", bdCommand, {prefix, title: "批量删除消息"}),
    commands: {bd: bdCommand}});
}
