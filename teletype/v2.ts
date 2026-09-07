import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";

interface State extends Record<string, unknown> { schemaVersion: number; autoMode: boolean; enabledUsers: string[]; maxEdits: number; }
const defaults: State = {schemaVersion: 1, autoMode: false, enabledUsers: [], maxEdits: 80};
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const help = (prefix: string) => `<b>打字机效果插件</b>\n<code>${prefix}teletype 文本</code>\n<code>${prefix}teletype on/off/status</code>`;

async function animate(message: MessageEnvelope, text: string, context: PluginContext, maxEdits: number): Promise<void> {
  const chars = Array.from(text).slice(0, 4096);
  const steps = Math.max(1, Math.ceil(chars.length / Math.max(1, maxEdits - 1)));
  let rendered = "";
  for (let index = 0; index < chars.length; index += steps) {
    context.signal.throwIfAborted();
    rendered += chars.slice(index, index + steps).join("");
    await context.telegram.edit(message, `${escape(rendered)}█`, {parseMode: "html"});
  }
  await context.telegram.edit(message, escape(chars.join("")), {parseMode: "html"});
}

export default function createTeletype() {
  return definePlugin({
    apiVersion: 1, id: "teletype", description: "手动或自动显示打字机编辑效果",
    commands: {teletype: {description: "打字机效果", ignoreEdited: true, async handle(invocation, context) {
      const store = context.storage.json<State>("config.json", defaults);
      const first = invocation.args[0]?.toLowerCase();
      if (!first) return context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
      if (["on", "off", "status"].includes(first)) {
        const user = invocation.message.senderId;
        if (!user) return context.telegram.edit(invocation.message, "❌ 无法获取用户ID", {});
        if (first === "status") {
          const state = await store.read();
          return context.telegram.edit(invocation.message, `📊 自动模式: ${state.autoMode && state.enabledUsers.includes(user) ? "🟢 开启" : "🔴 关闭"}`, {});
        }
        const enabled = first === "on";
        await store.update(state => ({...state, schemaVersion: 1, autoMode: enabled || state.enabledUsers.some(id => id !== user),
          enabledUsers: enabled ? [...new Set([...state.enabledUsers, user])] : state.enabledUsers.filter(id => id !== user),
          maxEdits: Math.min(100, Math.max(2, Number(state.maxEdits) || 80))}));
        return context.telegram.edit(invocation.message, `✅ 自动打字机模式已${enabled ? "开启" : "关闭"}`, {});
      }
      const state = await store.read();
      await animate(invocation.message, invocation.args.join(" "), context, state.maxEdits);
    }}},
    listeners: [{edited: false, ignoreCommands: true, async handle(message, context) {
      if (!message.outgoing || message.text.trim().length < 2) return;
      const state = await context.storage.json<State>("config.json", defaults).read();
      if (!state.autoMode || !message.senderId || !state.enabledUsers.includes(message.senderId)) return;
      await animate(message, message.text, context, state.maxEdits);
    }}],
    async setup(context) { await context.storage.json<State>("config.json", defaults).update(state => ({...state, schemaVersion: 1,
      autoMode: !!state.autoMode, enabledUsers: Array.isArray(state.enabledUsers) ? state.enabledUsers.map(String) : [],
      maxEdits: Math.min(100, Math.max(2, Number(state.maxEdits) || 80))})); },
    settings: context => ({title: "电传打字", description: "打字机效果配置", category: "插件配置", icon: "⌨️",
      getSchema: () => [{key: "maxEdits", label: "最大编辑次数", type: "number", min: 2, max: 100}],
      getValues: () => context.storage.json<State>("config.json", defaults).read(),
      async setValues(patch) { await context.storage.json<State>("config.json", defaults).update(state => ({...state,
        maxEdits: patch.maxEdits === undefined ? state.maxEdits : Math.min(100, Math.max(2, Number(patch.maxEdits)))})); }}),
  });
}
