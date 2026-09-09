import {renderHelp as renderPluginHelp} from "./v2/help";
import {Api} from "teleproto";
import {returnBigInt} from "teleproto/Helpers";
import {definePlugin, ui, type MessageEnvelope, type PluginContext} from "telebox/sdk";

type TaskType = "send" | "copy" | "forward" | "del" | "del_re" | "pin" | "unpin" | "cmd";
interface Task { id: string; type: TaskType; cron: string; chat: string; chatId?: string; createdAt: string; lastRunAt?: string; lastResult?: string; lastError?: string; disabled?: boolean; remark?: string; message?: string; replyTo?: string; fromChatId?: string; fromMsgId?: string; msgId?: string; limit?: string; regex?: string; notify?: boolean; pmOneSide?: boolean; delivery?: "pending" | "prepared" | "sent"; }
interface State extends Record<string, unknown> { schemaVersion: number; seq: string; tasks: Task[]; }
const defaults: State = {schemaVersion: 1, seq: "0", tasks: []};
const types: TaskType[] = ["send", "copy", "forward", "del", "del_re", "pin", "unpin", "cmd"];
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const validCron = (value: string) => value.trim().split(/\s+/).length === 6;
const parseRegex = (value: string) => { if (value.startsWith("/") && value.lastIndexOf("/") > 0) {const last = value.lastIndexOf("/"); return new RegExp(value.slice(1, last), value.slice(last + 1));} return new RegExp(value); };
const numeric = (value?: string) => value !== undefined && /^-?\d+$/.test(value) ? Number(value) : undefined;
const peer = (value?: string) => value !== undefined && /^-?\d+$/.test(value) ? returnBigInt(value) : value;
const help = (prefix: string) => `<b>定时任务</b>\n<code>${prefix}acron send/copy/forward/cmd CRON 对话</code>\n<code>${prefix}acron del/del_re/pin/unpin CRON 对话 参数</code>\n<code>${prefix}acron list/rm/disable/enable</code>`;

export default function createAcron() {
  const disposers = new Map<string, () => Promise<void>>(); let queue = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>) => {const result = queue.then(operation, operation); queue = result.then(() => undefined, () => undefined); return result;};
  const execute = async (context: PluginContext, id: string) => serial(async () => {
    const store = context.storage.json<State>("acron_config.json", defaults); const state = await store.read(); const task = state.tasks.find(item => item.id === id); if (!task || task.disabled) return;
    if (task.delivery === "prepared") { await store.update(current => {const found = current.tasks.find(item => item.id === id); if (found) {found.delivery = "pending"; found.lastError = "上次执行在确认结果前中断，已跳过以避免重复副作用";} return current;}); return; }
    await store.update(current => {const found = current.tasks.find(item => item.id === id); if (found) found.delivery = "prepared"; return current;});
    try {
      let result = "已执行";
      await context.telegram.withClient(async client => {
        const target = peer(task.chatId) ?? task.chat;
        if (task.type === "send" || task.type === "cmd") { await client.sendMessage(target, {message: task.message || "", ...(task.replyTo ? {replyTo: numeric(task.replyTo)} : {})}); result = task.type === "cmd" ? "已发送命令" : "已发送 1 条消息"; }
        else if (task.type === "copy") { const messages = await client.getMessages(peer(task.fromChatId), {ids: numeric(task.fromMsgId)}); if (!messages?.[0]) throw new Error("未能获取源消息"); await client.sendMessage(target, {message: messages[0], ...(task.replyTo ? {replyTo: numeric(task.replyTo)} : {})}); result = "已复制发送 1 条消息"; }
        else if (task.type === "forward") { await client.invoke(new Api.messages.ForwardMessages({fromPeer: peer(task.fromChatId)!, id: [numeric(task.fromMsgId)!], toPeer: target, ...(task.replyTo ? {topMsgId: numeric(task.replyTo)} : {})})); result = "已转发 1 条消息"; }
        else if (task.type === "del") { await client.deleteMessages(target, [numeric(task.msgId)!], {revoke: true}); result = `已尝试删除消息 ${task.msgId}`; }
        else if (task.type === "del_re") { const messages = await client.getMessages(target, {limit: Math.min(1000, numeric(task.limit) || 100)}); const regex = parseRegex(task.regex || ""); const ids = messages.filter((message: any) => {regex.lastIndex = 0; return regex.test(message.message || message.text || "");}).map((message: any) => message.id); if (ids.length) await client.deleteMessages(target, ids, {revoke: true}); result = `匹配并删除 ${ids.length} 条`; }
        else if (task.type === "pin") { await client.pinMessage(target, numeric(task.msgId)!, {notify: !!task.notify, pmOneSide: !!task.pmOneSide}); result = `已置顶消息 ${task.msgId}`; }
        else if (task.type === "unpin") { await client.unpinMessage(target, numeric(task.msgId)!); result = `已取消置顶消息 ${task.msgId}`; }
      });
      await store.update(current => {const found = current.tasks.find(item => item.id === id); if (found) {found.lastRunAt = String(Date.now()); found.lastResult = result; found.lastError = undefined; found.delivery = "sent";} return current;});
    } catch { await store.update(current => {const found = current.tasks.find(item => item.id === id); if (found) {found.lastRunAt = String(Date.now()); found.lastError = "任务执行失败"; found.delivery = "pending";} return current;}); }
  });
  const register = async (context: PluginContext, task: Task) => { if (task.disabled || disposers.has(task.id)) return; const dispose = await context.jobs.register(`task_${task.id}`, {cron: task.cron, timeZone: "Asia/Shanghai", description: `acron ${task.type} ${task.id}`}, () => execute(context, task.id)); disposers.set(task.id, dispose); };
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "acron", description: "定时发送、复制、转发、删除及置顶消息",
    commands: {acron: {helpOnEmpty: true, description: "管理 Cron 定时任务", async handle(invocation, context) {
      const store = context.storage.json<State>("acron_config.json", defaults); const sub = invocation.args[0]?.toLowerCase();
      if (!sub) return context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
      if (["list", "ls", "la"].includes(sub)) { const state = await store.read(); const all = sub === "la" || invocation.args[1] === "all"; const filterArg = sub === "la" ? invocation.args[1] : invocation.args[all ? 2 : 1]; const filter = types.includes(filterArg as TaskType) ? filterArg : undefined; const tasks = state.tasks.filter(task => (all || task.chatId === invocation.message.chatId) && (!filter || task.type === filter)); const text = tasks.length ? `📋 <b>${all ? "所有" : "当前会话"}定时任务 · ${tasks.length} 个</b>\n\n${tasks.map(task => `<code>${task.id}</code> · <code>${task.type}</code> · ${task.disabled ? "已禁用" : "已启用"}\n<code>${escape(task.cron)}</code>${task.remark ? ` · ${escape(task.remark)}` : ""}${task.lastResult ? `\n结果: ${escape(task.lastResult)}` : ""}${task.lastError ? `\n错误: ${escape(task.lastError)}` : ""}`).join("\n\n")}` : "暂无定时任务"; const pages = (await ui.renderRichText(text, ui.PAGE_LABEL_RESERVE)).map((page, index, all) => page + ui.pageLabel(index, all.length)); const delivery = await ui.deliverPages(pages, context.signal, (page, index) => index ? context.telegram.reply(invocation.message, page, {parseMode: "html"}) : context.telegram.edit(invocation.message, page, {parseMode: "html"})); if (delivery.interrupted) { context.log.info("pagination_delivery_interrupted", {plugin: "acron", published: delivery.published, total: delivery.total, category: ui.deliveryErrorCategory(delivery.error)}); if (delivery.published) { try { await context.telegram.reply(invocation.message, ui.interruptedNotice(delivery), {parseMode: "html"}); } catch {} } else throw delivery.error; } return; }
      if (["rm", "remove", "del_task", "disable", "off", "enable", "on"].includes(sub)) { const id = invocation.args[1]; const state = await store.read(); const task = state.tasks.find(item => item.id === id); if (!task) return context.telegram.edit(invocation.message, "未找到该任务", {}); if (["rm", "remove", "del_task"].includes(sub)) {await disposers.get(id)?.(); disposers.delete(id); await store.update(current => ({...current, tasks: current.tasks.filter(item => item.id !== id)})); return context.telegram.edit(invocation.message, `已删除任务 ${id}`, {});} const disabled = sub === "disable" || sub === "off"; if (disabled) {await disposers.get(id)?.(); disposers.delete(id);} await store.update(current => {const found = current.tasks.find(item => item.id === id); if (found) found.disabled = disabled; return current;}); if (!disabled) await register(context, {...task, disabled: false}); return context.telegram.edit(invocation.message, `任务 ${id} 已${disabled ? "禁用" : "启用"}`, {}); }
      if (!types.includes(sub as TaskType)) return context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
      const cron = invocation.args.slice(1, 7).join(" "); if (!validCron(cron)) return context.telegram.edit(invocation.message, "Cron 表达式必须为 6 段", {});
      const type = sub as TaskType; const target = invocation.args[7]; if (!target) return context.telegram.edit(invocation.message, "缺少目标对话", {}); const [chat, replyTo] = target.split("|");
      const state = await store.read(); const id = (BigInt(state.seq || "0") + 1n).toString(); let resolved = chat;
      try { resolved = await context.telegram.withClient(async client => String((await client.getEntity(chat)).id)); } catch {}
      const task: Task = {id, type, cron, chat, chatId: resolved, createdAt: String(Date.now()), delivery: "pending", ...(replyTo ? {replyTo} : {})}; const rest = [...invocation.args.slice(8)];
      if (["send", "copy", "forward", "cmd"].includes(type)) { const reply = await context.telegram.getReply(invocation.message); if (type === "send") {if (!reply?.text) return context.telegram.edit(invocation.message, "请回复要定时发送的文本消息", {}); task.message = reply.text;} else if (type === "cmd") {task.message = invocation.message.text.split(/\r?\n/).slice(1).join("\n").trim(); if (!task.message) return context.telegram.edit(invocation.message, "请换行填写要执行的命令", {});} else {if (!reply) return context.telegram.edit(invocation.message, "请回复源消息", {}); task.fromChatId = reply.chatId; task.fromMsgId = String(reply.id);} task.remark = rest.join(" "); }
      else if (type === "del") {task.msgId = rest.shift(); task.remark = rest.join(" "); if (!numeric(task.msgId)) return context.telegram.edit(invocation.message, "无效的消息ID", {});}
      else if (type === "del_re") {task.limit = rest.shift(); task.regex = rest.shift(); task.remark = rest.join(" "); try {parseRegex(task.regex || "");} catch {return context.telegram.edit(invocation.message, "无效的正则表达式", {});} }
      else if (type === "pin") {task.msgId = rest.shift(); task.notify = ["1", "true"].includes(rest.shift()?.toLowerCase() || ""); task.pmOneSide = ["1", "true"].includes(rest.shift()?.toLowerCase() || ""); task.remark = rest.join(" ");}
      else {task.msgId = rest.shift(); task.remark = rest.join(" ");}
      await store.update(current => ({...current, schemaVersion: 1, seq: id, tasks: [...current.tasks, task]})); try {await register(context, task);} catch {await store.update(current => ({...current, tasks: current.tasks.filter(item => item.id !== id), seq: state.seq})); return context.telegram.edit(invocation.message, "无效的 Cron 表达式", {});} return context.telegram.edit(invocation.message, `已添加定时任务 <code>${id}</code>`, {parseMode: "html"});
    }}},
    async setup(context) { const state = await context.storage.json<State>("acron_config.json", defaults).update(current => ({...current, schemaVersion: 1, seq: String(current.seq || "0"), tasks: (current.tasks || []).map(task => ({...task, id: String(task.id), chatId: task.chatId === undefined ? undefined : String(task.chatId), delivery: task.delivery || "pending"}))})); for (const task of state.tasks) await register(context, task); },
    async cleanup() {await Promise.all([...disposers.values()].map(dispose => dispose())); disposers.clear();},
  });
}
