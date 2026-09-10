import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {createHash} from "node:crypto";
import {setTimeout as sleep} from "node:timers/promises";
import {returnBigInt} from "teleproto/Helpers";

type Trigger = {timeWindow: number; minUsers: number};
type State = {schemaVersion: 1; enabledGroups: string[]; dailyHistory: Record<string, string[]>; lastDay: number; trigger: Trigger; [key: string]: unknown};
type Seen = {senderId: string; text: string; time: number};
type RuntimeState = {recent: Map<string, Seen[]>; serial: Map<string, Promise<void>>};
const defaults: State = {schemaVersion: 1, enabledGroups: [], dailyHistory: {}, lastDay: 0, trigger: {timeWindow: 300, minUsers: 5}};
const store = (context: PluginContext) => context.storage.json<State>("autorepeat.json", defaults);
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!));
const dayInShanghai = (now = Date.now()) => Math.floor((now + 8 * 3600_000) / 86400_000);
const contentKey = (text: string) => createHash("sha256").update(text).digest("hex");

function normalize(value: unknown): State {
  const source = value && typeof value === "object" ? value as Record<string, any> : {};
  const legacyGroups = source.cache?.autorepeat_settings;
  const enabledGroups = (Array.isArray(source.enabledGroups) ? source.enabledGroups : Array.isArray(legacyGroups) ? legacyGroups : [])
    .map(String).filter(id => /^-?\d+$/.test(id));
  const sourceHistory = source.dailyHistory ?? source.daily_history;
  const dailyHistory: Record<string, string[]> = {};
  if (sourceHistory && typeof sourceHistory === "object") for (const [id, values] of Object.entries(sourceHistory)) {
    if (/^-?\d+$/.test(id) && Array.isArray(values)) dailyHistory[id] = [...new Set(values.map(String))].slice(0, 5000);
  }
  const rawTrigger = source.trigger ?? source.trigger_config ?? {};
  const timeWindow = Number(rawTrigger.timeWindow), minUsers = Number(rawTrigger.minUsers);
  return {...source, schemaVersion: 1, enabledGroups: [...new Set(enabledGroups)], dailyHistory,
    lastDay: Number.isInteger(Number(source.lastDay ?? source.last_day_check)) ? Number(source.lastDay ?? source.last_day_check) : 0,
    trigger: {timeWindow: Number.isInteger(timeWindow) && timeWindow > 0 && timeWindow <= 86400 ? timeWindow : 300,
      minUsers: Number.isInteger(minUsers) && minUsers > 1 && minUsers <= 1000 ? minUsers : 5}};
}
async function updateState(context: PluginContext, transform: (state: State) => State) {
  return store(context).update(value => transform(normalize(value)));
}
async function edit(context: PluginContext, message: MessageEnvelope, text: string, html = false, expire = true) {
  await context.telegram.edit(message, text, html ? {parseMode: "html", linkPreview: false} : {});
  if (!expire) return;
  void context.tasks.run(`autorepeat:expire:${message.chatId}:${message.id}`, async signal => {
    try {
      await sleep(30_000, undefined, {signal});
      await context.telegram.withClient(async client => client.deleteMessages(returnBigInt(message.chatId), [message.id], {revoke: true}));
    } catch (error) {
      if (!signal.aborted) context.log.error("autorepeat:expire", {error: String(error).slice(0, 300)});
    }
  });
}
async function resolveGroup(context: PluginContext, message: MessageEnvelope, identifier?: string): Promise<{id: string; title: string}> {
  return context.telegram.withClient(async client => {
    let target: any = identifier;
    let knownId: string | undefined = identifier === undefined && !message.replyToId ? message.chatId : undefined;
    if (!target && message.replyToId) {
      const reply = await context.telegram.getReply(message);
      target = (reply?.raw as any)?.fwdFrom?.fromId;
    }
    if (!target) target = (message.raw as any)?.peerId ?? returnBigInt(message.chatId);
    if (typeof target === "string") {
      const match = target.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)$/) ?? target.match(/^@?([A-Za-z0-9_]+)$/);
      if (match && !/^-?\d+$/.test(target)) target = match[1];
      else if (/^-?\d+$/.test(target)) target = returnBigInt(target);
    }
    const entity: any = await client.getEntity(target);
    if (entity?.className !== "Chat" && !(entity?.className === "Channel" && entity.megagroup)) throw new Error("目标不是群组");
    let id: string = knownId ?? "";
    try {
      const {utils} = await import("teleproto");
      if (!id) id = String(utils.getPeerId(entity));
    } catch { if (!id) id = String(entity.id); }
    return {id, title: String(entity.title ?? `群组 ${id}`)};
  });
}
async function allGroups(context: PluginContext): Promise<string[]> {
  return context.telegram.withClient(async client => {
    const groups = new Set<string>();
    for (const folder of [0, 1]) for await (const dialog of client.iterDialogs({folder})) {
      if (dialog.isGroup || (dialog.isChannel && (dialog.entity as any)?.megagroup)) groups.add(String(dialog.id));
    }
    return [...groups];
  });
}
async function processMessage(message: MessageEnvelope, context: PluginContext, {recent, serial}: RuntimeState) {
  const chatId = message.chatId;
  const previous = serial.get(chatId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const now = Date.now(), today = dayInShanghai(now);
    let repeat = false;
    await updateState(context, value => {
      if (value.lastDay !== today) value = {...value, lastDay: today, dailyHistory: {}};
      if (!value.enabledGroups.includes(chatId)) return value;
      const windowStart = now - value.trigger.timeWindow * 1000;
      const messages = (recent.get(chatId) ?? []).filter(item => item.time >= windowStart);
      messages.push({senderId: message.senderId!, text: message.text, time: now});
      recent.set(chatId, messages.slice(-5000));
      const unique = new Set(messages.filter(item => item.text === message.text).map(item => item.senderId));
      const token = contentKey(message.text), history = value.dailyHistory[chatId] ?? [];
      if (unique.size >= value.trigger.minUsers && !history.includes(token)) {
        repeat = true;
        return {...value, dailyHistory: {...value.dailyHistory, [chatId]: [...history, token].slice(-5000)}};
      }
      return value;
    });
    if (!repeat || context.signal.aborted) return;
    await context.telegram.withClient(async client => client.sendMessage(returnBigInt(chatId), {message: message.text}));
  });
  serial.set(chatId, current);
  try { await current; } finally { if (serial.get(chatId) === current) serial.delete(chatId); }
}

export default function createPlugin() {
  const runtime: RuntimeState = {recent: new Map(), serial: new Map()};
  const guard = (run: (invocation: CommandInvocation, context: PluginContext) => Promise<void>) =>
    async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
      try { await run(invocation, context); }
      catch (error) { if (!context.signal.aborted) await edit(context, invocation.message, `❌ 操作失败: <code>${escape(error instanceof Error ? error.message : error)}</code>`, true); }
    };
  const allon = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    await edit(context, invocation.message, "🔄 正在扫描所有群组...", false, false);
    const ids = await allGroups(context);
    await updateState(context, state => ({...state, enabledGroups: [...new Set([...state.enabledGroups, ...ids])]}));
    await edit(context, invocation.message, `✅ 已开启 ${ids.length} 个群组的自动复读`);
  };
  const alloff = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    await updateState(context, state => ({...state, enabledGroups: []}));
    await edit(context, invocation.message, "✅ 已关闭所有群组的自动复读");
  };
  const set = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const timeWindow = Number(invocation.args[0]), minUsers = Number(invocation.args[1]);
    if (!Number.isInteger(timeWindow) || timeWindow < 1 || timeWindow > 86400 || !Number.isInteger(minUsers) || minUsers < 2 || minUsers > 1000) {
      await edit(context, invocation.message, `❌ 参数错误\n使用格式: <code>${invocation.prefix}autorepeat set [1-86400秒] [2-1000人]</code>`, true); return;
    }
    await updateState(context, state => ({...state, trigger: {timeWindow, minUsers}}));
    await edit(context, invocation.message, `✅ 触发条件已更新\n时间窗口: ${timeWindow}秒\n最少人数: ${minUsers}人`);
  };
  const list = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const state = await store(context).read(), page = Math.max(1, Number(invocation.args[0]) || 1), ids = state.enabledGroups, pages = Math.max(1, Math.ceil(ids.length / 20));
    if (!ids.length) { await edit(context, invocation.message, "📝 当前没有开启自动复读的群组"); return; }
    const rows: string[] = [];
    for (const id of ids.slice((page - 1) * 20, page * 20)) {
      try { const title = await context.telegram.withClient(async client => String((await client.getEntity(returnBigInt(id)) as any).title ?? id)); rows.push(`• <b>${escape(title)}</b> (<code>${escape(id)}</code>)`); }
      catch { rows.push(`• <code>${escape(id)}</code> (无法获取信息)`); }
    }
    await edit(context, invocation.message, `📝 <b>已开启自动复读群组 (${ids.length})</b>\n<b>第 ${Math.min(page, pages)}/${pages} 页</b>\n\n${rows.join("\n")}`, true);
  };
  const toggle = (on: boolean) => async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const group = await resolveGroup(context, invocation.message, invocation.args[0]);
    await updateState(context, state => ({...state, enabledGroups: on ? [...new Set([...state.enabledGroups, group.id])] : state.enabledGroups.filter(id => id !== group.id)}));
    await edit(context, invocation.message, `${on ? "✅ 已开启" : "❌ 已关闭"} <b>${escape(group.title)}</b> 的自动复读`, true);
  };
  const autorepeat: CommandDefinition = {
    description: "管理群组自动复读",
    args: "[on|off] [群组]",
    arguments: [{name: "on|off", description: "开启或关闭当前/指定群组"}, {name: "群组", description: "群组ID / @群组名 / https://t.me/群组名"}],
    examples: [{args: ""}, {args: "on"}, {args: "off @group"}, {args: "list"}, {args: "set 300 5"}],
    help: [
      {heading: "高级用法：", body: "• 在群组内直接使用 <code>{prefix}autorepeat on/off</code> 切换当前群组\n• 从目标群组转发消息后，回复该消息并使用 <code>{prefix}autorepeat on/off</code> 可切换该群组状态\n• <code>set</code> 自定义触发条件，默认 300 秒内 5 人"},
      {heading: "复读规则：", body: "• 触发条件：默认5分钟内有5位不同用户发送完全相同的内容\n• 每日限制：同一群组内，相同内容每天只会自动复读一次 (UTC+8 0点重置)\n• 忽略规则：匿名消息、非文本消息、自己发送的消息、机器人消息会被忽略"},
    ],
    subcommandsCaseSensitive: false,
    subcommands: {
      allon: {description: "开启全部群组自动复读", args: "", examples: [{args: "allon"}], handle: guard(allon)},
      alloff: {description: "关闭全部群组自动复读", args: "", examples: [{args: "alloff"}], handle: guard(alloff)},
      set: {description: "自定义触发条件", args: "[时间] [人数]", arguments: [{name: "时间", required: true, description: "1-86400 秒"}, {name: "人数", required: true, description: "2-1000 人"}], examples: [{args: "set 300 5"}], handle: guard(set)},
      list: {description: "查看已开启的群组", args: "[页码]", examples: [{args: "list"}], handle: guard(list)},
      on: {description: "开启当前或指定群组", args: "[群组]", examples: [{args: "on"}], handle: guard(toggle(true))},
      off: {description: "关闭当前或指定群组", args: "[群组]", examples: [{args: "off"}], handle: guard(toggle(false))},
    },
    handle: guard(async (invocation, context) => {
      try {
        const group = await resolveGroup(context, invocation.message);
        const state = await store(context).read();
        await edit(context, invocation.message, `🤖 <b>${escape(group.title)}</b>\n群组ID: <code>${escape(group.id)}</code>\n状态: ${state.enabledGroups.includes(group.id) ? "✅ 已开启" : "❌ 已关闭"}\n触发条件: ${state.trigger.timeWindow}秒内${state.trigger.minUsers}人`, true);
      } catch {
        await edit(context, invocation.message, renderCommandHelp("autorepeat", autorepeat, {prefix: invocation.prefix}), true);
      }
    }),
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "autorepeat", description: "在群组内达到不同用户人数阈值后自动复读相同文本。",
    renderHelp: prefix => renderCommandHelp("autorepeat", autorepeat, {prefix, title: "自动复读插件使用说明"}),
    commands: {autorepeat},
    listeners: [{edited: false, ignoreCommands: true, direction: "incoming", ignoreForwarded: true, async handle(message, context) {
      if (!message.senderId || !message.text) return;
      const raw: any = message.raw;
      const date = Number(raw?.date);
      if (Number.isFinite(date) && Date.now() / 1000 - date > 60) return;
      if (raw?.sender?.bot === true || raw?.sender?.className !== "User") return;
      try { await processMessage(message, context, runtime); }
      catch (error) { if (!context.signal.aborted) context.log.error("autorepeat:listener", {error: String(error).slice(0, 300)}); }
    }}],
    async setup(context) { await store(context).update(value => normalize(value)); },
    cleanup() { runtime.recent.clear(); runtime.serial.clear(); },
  });
}
