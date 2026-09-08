import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext} from "telebox/sdk";
import {returnBigInt} from "teleproto/Helpers";

interface Task { task_id: number; cid: string; msg: string; interval: boolean; cron: boolean; pause: boolean; time_limit: number; hour: string; minute: string; second: string; current_count: number; dueAt?: string; delivery?: "pending" | "prepared" | "sent"; }
interface State extends Record<string, unknown> { schemaVersion: number; tasks: Task[]; timezone: string; }
const defaults: State = {schemaVersion: 1, tasks: [], timezone: "Asia/Shanghai"};
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const help = (prefix: string) => `<b>定时发送消息插件</b>\n<code>${prefix}sendat 时间 | 消息内容</code>\n<code>${prefix}sendat list/rm/pause/resume</code>`;
const validZone = (zone: string) => {try {new Intl.DateTimeFormat("en", {timeZone: zone}).format(); return true;} catch {return false;}};
function nextShanghai(hour: number, minute: number, second: number): string { const parts = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).formatToParts(new Date()); const get = (type: string) => parts.find(part => part.type === type)!.value; let due = new Date(`${get("year")}-${get("month")}-${get("day")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}+08:00`); if (due <= new Date()) due = new Date(due.getTime() + 86_400_000); return due.toISOString(); }

function parseTime(value: string, min: number, max?: number): string { const number = Number(value); if (!Number.isInteger(number) || number < min || (max !== undefined && number > max)) throw new Error(`时间值 ${value} 无效`); return String(number); }
function parseTask(id: number, cid: string, source: string): Task {
  const split = source.indexOf("|"); if (split < 0) throw new Error("任务格式错误，请使用 '时间 | 消息内容'");
  const message = source.slice(split + 1).trim(); if (!message) throw new Error("消息内容不能为空");
  let spec = source.slice(0, split).trim(); const every = /\bevery\b/i.test(spec); spec = spec.replace(/\bevery\b/i, "").trim();
  const parts = spec.split(/\s+/); if (!parts.length || parts.length % 2) throw new Error("时间格式错误");
  const task: Task = {task_id: id, cid, msg: message, interval: every, cron: false, pause: false, time_limit: -1, hour: "0", minute: "0", second: "0", current_count: 0, delivery: "pending"};
  let hasTime = false;
  for (let i = 0; i < parts.length; i += 2) { const value = parts[i], unit = parts[i + 1].toLowerCase();
    if (unit === "times") task.time_limit = Number(parseTime(value, 1));
    else if (unit === "seconds") {task.second = parseTime(value, 1, 59); hasTime = true; task.interval = true;}
    else if (unit === "minutes") {task.minute = parseTime(value, 1, 59); hasTime = true; task.interval = true;}
    else if (unit === "hours") {task.hour = parseTime(value, 1, 23); hasTime = true; task.interval = true;}
    else if (unit === "date") { const bits = value.split(":"); if (bits.length !== 3) throw new Error("时间格式应为 HH:MM:SS"); task.hour = parseTime(bits[0], 0, 23); task.minute = parseTime(bits[1], 0, 59); task.second = parseTime(bits[2], 0, 59); task.cron = true; task.interval = every; hasTime = true; }
    else throw new Error(`未知的时间单位: ${unit}`);
  }
  if (!hasTime) throw new Error("时间格式错误");
  if (task.cron && !task.interval) task.dueAt = nextShanghai(+task.hour, +task.minute, +task.second);
  return task;
}
function cronFor(task: Task): string {
  if (task.cron && task.interval) return `${task.second} ${task.minute} ${task.hour} * * *`;
  if (task.cron && task.dueAt) { const d = new Date(task.dueAt); return `${d.getSeconds()} ${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`; }
  if (+task.hour) return `${task.second} ${task.minute} */${task.hour} * * *`;
  if (+task.minute) return `${task.second} */${task.minute} * * * *`;
  return `*/${task.second} * * * * *`;
}
const description = (task: Task) => `任务 #${task.task_id}${task.pause ? " [已暂停]" : ""}\n消息: ${escape(task.msg.slice(0, 50))}`;

export default function createSendAt() {
  const disposers = new Map<number, () => Promise<void>>(); let write = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => { const result = write.then(operation, operation); write = result.then(() => undefined, () => undefined); return result; };
  const execute = async (context: PluginContext, id: number) => serialized(async () => {
    const store = context.storage.json<State>("tasks.json", defaults); let task = (await store.read()).tasks.find(item => item.task_id === id); if (!task || task.pause) return;
    if (task.delivery === "prepared") { await store.update(state => { const found = state.tasks.find(item => item.task_id === id); if (found) found.delivery = "pending"; return state; }); return; }
    await store.update(state => { const found = state.tasks.find(item => item.task_id === id); if (found) found.delivery = "prepared"; return state; });
    await context.telegram.withClient(async client => client.sendMessage(returnBigInt(task!.cid), {message: task!.msg, parseMode: "html"}));
    let remove = false;
    await store.update(state => { const found = state.tasks.find(item => item.task_id === id); if (!found) return state; found.current_count += 1; found.delivery = "sent"; if (!found.interval || (found.time_limit > 0 && --found.time_limit === 0)) {state.tasks = state.tasks.filter(item => item.task_id !== id); remove = true;} else found.delivery = "pending"; return state; });
    if (remove) { await disposers.get(id)?.(); disposers.delete(id); }
  });
  const register = async (context: PluginContext, task: Task, timeZone = "Asia/Shanghai") => { if (task.pause || disposers.has(task.task_id)) return; const dispose = await context.jobs.register(`task_${task.task_id}`, {cron: cronFor(task), timeZone, description: `定时发送任务 ${task.task_id}`}, () => execute(context, task.task_id)); disposers.set(task.task_id, dispose); };
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "sendat", description: "按固定时间或间隔发送消息",
    commands: {sendat: {helpArgs: ["help","h"], helpOnEmpty: true, description: "管理定时发送任务", async handle(invocation, context) {
      const store = context.storage.json<State>("tasks.json", defaults); const sub = invocation.args[0]?.toLowerCase();
      if (!sub || sub === "help" || sub === "h") return context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
      if (sub === "list") { const all = invocation.args[1] === "all"; if (all) return context.telegram.edit(invocation.message, "❌ 只有管理员可以查看所有任务", {}); const tasks = (await store.read()).tasks.filter(task => task.cid === invocation.message.chatId); return context.telegram.edit(invocation.message, tasks.length ? `📋 <b>我的任务：</b>\n\n${tasks.map(description).join("\n\n")}` : "📝 您没有已注册的任务", {parseMode: "html"}); }
      if (["rm", "delete", "pause", "resume"].includes(sub)) { const id = Number(invocation.args[1]); if (!Number.isInteger(id)) return context.telegram.edit(invocation.message, "❌ 请输入有效的任务ID", {}); const state = await store.read(); const task = state.tasks.find(item => item.task_id === id); if (!task) return context.telegram.edit(invocation.message, "❌ 任务不存在", {}); if (task.cid !== invocation.message.chatId) return context.telegram.edit(invocation.message, "❌ 只能管理自己的任务", {});
        if (sub === "rm" || sub === "delete") { await disposers.get(id)?.(); disposers.delete(id); await store.update(current => ({...current, tasks: current.tasks.filter(item => item.task_id !== id)})); return context.telegram.edit(invocation.message, `✅ 已删除任务 #${id}`, {}); }
        const pause = sub === "pause"; if (task.pause === pause) return context.telegram.edit(invocation.message, `❌ ${pause ? "暂停" : "恢复"}任务失败`, {}); if (pause) {await disposers.get(id)?.(); disposers.delete(id);} await store.update(current => {const found = current.tasks.find(item => item.task_id === id); if (found) found.pause = pause; return current;}); if (!pause) await register(context, {...task, pause: false}, state.timezone); return context.telegram.edit(invocation.message, `${pause ? "⏸️ 已暂停" : "▶️ 已恢复"}任务 #${id}`, {});
      }
      const raw = invocation.message.text.replace(/^\S+\s*/, "");
      try { const state = await store.read(); const task = parseTask(Math.max(0, ...state.tasks.map(item => item.task_id)) + 1, invocation.message.chatId, raw); await store.update(current => ({...current, schemaVersion: 1, tasks: [...current.tasks, task]})); await register(context, task, state.timezone); return context.telegram.edit(invocation.message, `✅ <b>已添加任务 #${task.task_id}</b>\n\n${description(task)}`, {parseMode: "html"}); } catch (error) { return context.telegram.edit(invocation.message, `❌ <b>错误：</b>${escape(error instanceof Error ? error.message : "添加任务失败")}`, {parseMode: "html"}); }
    }}},
    async setup(context) { const store = context.storage.json<State>("tasks.json", defaults); const state = await store.update(current => ({...current, schemaVersion: 1, timezone: current.timezone && validZone(current.timezone) ? current.timezone : "Asia/Shanghai", tasks: (current.tasks || []).filter(task => task.delivery !== "prepared" || task.interval).map(task => ({...task, cid: String(task.cid), current_count: task.current_count || 0, delivery: task.delivery === "prepared" ? "pending" : task.delivery || "pending"}))})); for (const task of state.tasks) { if (!task.pause && task.dueAt && Date.parse(task.dueAt) <= Date.now()) await execute(context, task.task_id); else await register(context, task, state.timezone); } },
    async cleanup() { await Promise.all([...disposers.values()].map(dispose => dispose())); disposers.clear(); },
    settings: context => ({title: "定时发送", category: "插件配置", icon: "📅", getSchema: () => [{key: "timezone", label: "时区", type: "string"}], async getValues() {return {timezone: (await context.storage.json<State>("tasks.json", defaults).read()).timezone};}, async setValues(patch) {if (patch.timezone !== undefined && (typeof patch.timezone !== "string" || !validZone(patch.timezone))) throw new Error("invalid timezone"); const state = await context.storage.json<State>("tasks.json", defaults).update(current => ({...current, ...(patch.timezone ? {timezone: patch.timezone as string} : {})})); await Promise.all([...disposers.values()].map(dispose => dispose())); disposers.clear(); for (const task of state.tasks) await register(context, task, state.timezone);}}),
  });
}
