import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type MessageEnvelope} from "telebox/sdk";


// Keep the group send-as boundary compatible with Core owner commands.
function isOwnerOrGroupSendAs(message: MessageEnvelope, ownerId: string): boolean {
  if (message.senderId === ownerId) return true;
  const raw = message.raw as {className?: string; post?: boolean} | undefined;
  return message.outgoing && !message.forwarded && !message.edited &&
    raw?.className === "Message" && !raw.post && /^-100[1-9][0-9]*$/.test(message.chatId) &&
    /^-100[1-9][0-9]*$/.test(message.senderId ?? "") && /^[1-9][0-9]*$/.test(ownerId);
}

interface SureConfig extends Record<string, unknown> {users: string[]; chats: string[]; messages: Record<string, string>;}
const defaults: SureConfig = {users: [], chats: [], messages: {}};

export default function createSure() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "sure", description: "管理 bot 代发消息的白名单规则",
    commands: {sure: {description: "维护代发用户、对话和消息白名单", async handle(invocation, ctx) {
      const owner = await ctx.telegram.withClient(client => client.getMe());
      if (!isOwnerOrGroupSendAs(invocation.message, String(owner.id))) {
        await ctx.telegram.edit(invocation.message, "只有 owner 可以管理 sure 白名单");
        return;
      }
      const store = ctx.storage.json<SureConfig>("config.json", defaults);
      const [scope, action, value] = invocation.args;
      if (scope === "user" || scope === "chat") {
        if ((action !== "add" && action !== "del") || !value || !(scope === "user" ? /^[1-9][0-9]*$/ : /^-?[1-9][0-9]*$/).test(value)) {
          await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}sure user|chat add|del ID`);
          return;
        }
        await store.update(current => {
          const key = scope === "user" ? "users" : "chats";
          const values = new Set(current[key]);
          if (action === "add") values.add(value); else values.delete(value);
          return {...current, [key]: [...values]};
        });
        await ctx.telegram.edit(invocation.message, `sure ${scope} 已${action === "add" ? "添加" : "删除"}：<code>${value}</code>`, {parseMode: "html"});
        return;
      }
      if (scope === "msg" && action === "add" && value) {
        await store.update(current => ({...current, messages: {...current.messages, [value]: value}}));
        await ctx.telegram.edit(invocation.message, "sure 消息规则已添加");
        return;
      }
      if (scope === "ls" || scope === "list") {
        const current = await store.read();
        await ctx.telegram.edit(invocation.message,
          `<b>sure 白名单</b>\n用户：${current.users.length}\n对话：${current.chats.length}\n消息规则：${Object.keys(current.messages).length}`, {parseMode: "html"});
        return;
      }
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}sure user|chat|msg add|del ...`);
    }}},
    listeners: [{handle: async (message, ctx) => {
      if (message.outgoing || !message.senderId || !message.text.trim()) return;
      const store = ctx.storage.json<SureConfig>("config.json", defaults);
      const current = await store.read();
      if (!current.users.includes(message.senderId) ||
          (current.chats.length > 0 && !current.chats.includes(message.chatId))) return;
      const replacement = current.messages[message.text] ?? current.messages[`_command:${message.text.split(/\s+/, 1)[0]}`];
      if (!replacement || replacement.startsWith("_command:")) return;
      await ctx.telegram.withClient(async client => {
        const raw = message.raw as {peerId?: unknown} | undefined;
        if (raw?.peerId) await client.sendMessage(raw.peerId as never, {message: replacement});
      });
    }}],
  });
}
