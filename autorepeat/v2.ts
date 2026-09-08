import {renderHelp as renderPluginHelp} from "./v2/help";
import {createHash} from "node:crypto";
import {setTimeout as sleep} from "node:timers/promises";
import {returnBigInt} from "teleproto/Helpers";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";

type Trigger = {timeWindow: number; minUsers: number};
type State = {schemaVersion: 1; enabledGroups: string[]; dailyHistory: Record<string, string[]>; lastDay: number; trigger: Trigger; [key: string]: unknown};
type Seen = {senderId: string; text: string; time: number};
const defaults: State = {schemaVersion: 1, enabledGroups: [], dailyHistory: {}, lastDay: 0, trigger: {timeWindow: 300, minUsers: 5}};
const store = (context: PluginContext) => context.storage.json<State>("autorepeat.json", defaults);
const recent = new Map<string, Seen[]>();
const serial = new Map<string, Promise<void>>();
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

async function processMessage(message: MessageEnvelope, context: PluginContext) {
  const chatId = message.chatId;
  const previous = serial.get(chatId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const now = Date.now(), today = dayInShanghai(now);
    let repeat = false;
    const state = await updateState(context, value => {
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

export default function createPlugin() { return definePlugin({renderHelp: renderPluginHelp,
  apiVersion: 1, id: "autorepeat", description: "在群组内达到不同用户人数阈值后自动复读相同文本。",
  commands: {autorepeat: {description: "管理群组自动复读", async handle({message, args, prefix}, context) {
    try {
      const action = args[0]?.toLowerCase();
      if (action === "allon") {
        await edit(context, message, "🔄 正在扫描所有群组...", false, false);
        const ids = await allGroups(context); await updateState(context, state => ({...state, enabledGroups: [...new Set([...state.enabledGroups, ...ids])]}));
        await edit(context, message, `✅ 已开启 ${ids.length} 个群组的自动复读`); return;
      }
      if (action === "alloff") { await updateState(context, state => ({...state, enabledGroups: []})); await edit(context, message, "✅ 已关闭所有群组的自动复读"); return; }
      if (action === "set") {
        const timeWindow = Number(args[1]), minUsers = Number(args[2]);
        if (!Number.isInteger(timeWindow) || timeWindow < 1 || timeWindow > 86400 || !Number.isInteger(minUsers) || minUsers < 2 || minUsers > 1000) {
          await edit(context, message, `❌ 参数错误\n使用格式: <code>${prefix}autorepeat set [1-86400秒] [2-1000人]</code>`, true); return;
        }
        await updateState(context, state => ({...state, trigger: {timeWindow, minUsers}}));
        await edit(context, message, `✅ 触发条件已更新\n时间窗口: ${timeWindow}秒\n最少人数: ${minUsers}人`); return;
      }
      if (action === "list") {
        const state = await store(context).read(), page = Math.max(1, Number(args[1]) || 1), ids = state.enabledGroups, pages = Math.max(1, Math.ceil(ids.length / 20));
        if (!ids.length) { await edit(context, message, "📝 当前没有开启自动复读的群组"); return; }
        const rows: string[] = [];
        for (const id of ids.slice((page - 1) * 20, page * 20)) {
          try { const title = await context.telegram.withClient(async client => String((await client.getEntity(returnBigInt(id)) as any).title ?? id)); rows.push(`• <b>${escape(title)}</b> (<code>${escape(id)}</code>)`); }
          catch { rows.push(`• <code>${escape(id)}</code> (无法获取信息)`); }
        }
        await edit(context, message, `📝 <b>已开启自动复读群组 (${ids.length})</b>\n<b>第 ${Math.min(page, pages)}/${pages} 页</b>\n\n${rows.join("\n")}`, true); return;
      }
      if (["on", "off"].includes(action)) {
        const group = await resolveGroup(context, message, args[1]);
        await updateState(context, state => ({...state, enabledGroups: action === "on" ? [...new Set([...state.enabledGroups, group.id])] : state.enabledGroups.filter(id => id !== group.id)}));
        await edit(context, message, `${action === "on" ? "✅ 已开启" : "❌ 已关闭"} <b>${escape(group.title)}</b> 的自动复读`, true); return;
      }
      try {
        const group = await resolveGroup(context, message);
        const state = await store(context).read();
        await edit(context, message, `🤖 <b>${escape(group.title)}</b>\n群组ID: <code>${escape(group.id)}</code>\n状态: ${state.enabledGroups.includes(group.id) ? "✅ 已开启" : "❌ 已关闭"}\n触发条件: ${state.trigger.timeWindow}秒内${state.trigger.minUsers}人`, true); return;
      } catch {
        await edit(context, message, `<b>自动复读</b>\n<code>${prefix}autorepeat on|off [群组]</code>\n<code>${prefix}autorepeat allon|alloff|list</code>\n<code>${prefix}autorepeat set [秒] [人数]</code>`, true);
      }
    } catch (error) { if (!context.signal.aborted) await edit(context, message, `❌ 操作失败: <code>${escape(error instanceof Error ? error.message : error)}</code>`, true); }
  }}},
  listeners: [{edited: false, ignoreCommands: true, async handle(message, context) {
    if (message.outgoing || !message.senderId || !message.text || message.forwarded) return;
    const raw: any = message.raw;
    const date = Number(raw?.date);
    if (Number.isFinite(date) && Date.now() / 1000 - date > 60) return;
    if (raw?.sender?.bot === true || raw?.sender?.className !== "User") return;
    try { await processMessage(message, context); }
    catch (error) { if (!context.signal.aborted) context.log.error("autorepeat:listener", {error: String(error).slice(0, 300)}); }
  }}],
  async setup(context) { await store(context).update(value => normalize(value)); },
  cleanup() { recent.clear(); serial.clear(); },
}); }
