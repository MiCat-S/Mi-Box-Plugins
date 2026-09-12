import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, ui, type CommandDefinition, type CommandInvocation, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {Api} from "teleproto";
import {returnBigInt} from "teleproto/Helpers";

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

  const listTasks = async (invocation: CommandInvocation, context: PluginContext, all: boolean, filterArg: string | undefined): Promise<void> => {
    const store = context.storage.json<State>("acron_config.json", defaults); const state = await store.read();
    const filter = types.includes(filterArg as TaskType) ? filterArg : undefined;
    const tasks = state.tasks.filter(task => (all || task.chatId === invocation.message.chatId) && (!filter || task.type === filter));
    const text = tasks.length ? `📋 <b>${all ? "所有" : "当前会话"}定时任务 · ${tasks.length} 个</b>\n\n${tasks.map(task => `<code>${task.id}</code> · <code>${task.type}</code> · ${task.disabled ? "已禁用" : "已启用"}\n<code>${escape(task.cron)}</code>${task.remark ? ` · ${escape(task.remark)}` : ""}${task.lastResult ? `\n结果: ${escape(task.lastResult)}` : ""}${task.lastError ? `\n错误: ${escape(task.lastError)}` : ""}`).join("\n\n")}` : "暂无定时任务";
    const pages = (await ui.renderRichText(text, ui.PAGE_LABEL_RESERVE)).map((page, index, allPages) => page + ui.pageLabel(index, allPages.length));
    const delivery = await ui.deliverPages(pages, context.signal, (page, index) => index ? context.telegram.reply(invocation.message, page, {parseMode: "html"}) : context.telegram.edit(invocation.message, page, {parseMode: "html"}));
    if (delivery.interrupted) { context.log.info("pagination_delivery_interrupted", {plugin: "acron", published: delivery.published, total: delivery.total, category: ui.deliveryErrorCategory(delivery.error)}); if (delivery.published) { try { await context.telegram.reply(invocation.message, ui.interruptedNotice(delivery), {parseMode: "html"}); } catch {} } else throw delivery.error; }
  };
  const controlTask = async (invocation: CommandInvocation, context: PluginContext, action: "remove" | "disable" | "enable"): Promise<void> => {
    const store = context.storage.json<State>("acron_config.json", defaults); const id = invocation.args[0]; const state = await store.read(); const task = state.tasks.find(item => item.id === id);
    if (!task) { await context.telegram.edit(invocation.message, "未找到该任务", {}); return; }
    if (action === "remove") { await disposers.get(id!)?.(); disposers.delete(id!); await store.update(current => ({...current, tasks: current.tasks.filter(item => item.id !== id)})); await context.telegram.edit(invocation.message, `已删除任务 ${id}`, {}); return; }
    const disabled = action === "disable";
    if (disabled) { await disposers.get(id!)?.(); disposers.delete(id!); }
    await store.update(current => {const found = current.tasks.find(item => item.id === id); if (found) found.disabled = disabled; return current;});
    if (!disabled) await register(context, {...task, disabled: false});
    await context.telegram.edit(invocation.message, `任务 ${id} 已${disabled ? "禁用" : "启用"}`, {});
  };
  const createTask = (type: TaskType) => async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const store = context.storage.json<State>("acron_config.json", defaults);
    const cron = invocation.args.slice(0, 6).join(" ");
    if (!validCron(cron)) { await context.telegram.edit(invocation.message, "Cron 表达式必须为 6 段", {}); return; }
    const target = invocation.args[6];
    if (!target) { await context.telegram.edit(invocation.message, "缺少目标对话", {}); return; }
    const [chat, replyTo] = target.split("|");
    let resolved = chat;
    try { resolved = await context.telegram.withClient(async client => String((await client.getEntity(chat!)).id)); } catch {}
    let task: Task = {id: "", type, cron, chat: chat!, chatId: resolved, createdAt: String(Date.now()), delivery: "pending", ...(replyTo ? {replyTo} : {})};
    const rest = [...invocation.args.slice(7)];
    if (["send", "copy", "forward", "cmd"].includes(type)) {
      const reply = await context.telegram.getReply(invocation.message);
      if (type === "send") { if (!reply?.text) { await context.telegram.edit(invocation.message, "请回复要定时发送的文本消息", {}); return; } task.message = reply.text; }
      else if (type === "cmd") { task.message = invocation.message.text.split(/\r?\n/).slice(1).join("\n").trim(); if (!task.message) { await context.telegram.edit(invocation.message, "请换行填写要发送的命令文本", {}); return; } }
      else { if (!reply) { await context.telegram.edit(invocation.message, "请回复源消息", {}); return; } task.fromChatId = reply.chatId; task.fromMsgId = String(reply.id); }
      task.remark = rest.join(" ");
    } else if (type === "del") { task.msgId = rest.shift(); task.remark = rest.join(" "); if (!numeric(task.msgId)) { await context.telegram.edit(invocation.message, "无效的消息ID", {}); return; } }
    else if (type === "del_re") { task.limit = rest.shift(); task.regex = rest.shift(); task.remark = rest.join(" "); try {parseRegex(task.regex || "");} catch { await context.telegram.edit(invocation.message, "无效的正则表达式", {}); return; } }
    else if (type === "pin") { task.msgId = rest.shift(); task.notify = ["1", "true"].includes(rest.shift()?.toLowerCase() || ""); task.pmOneSide = ["1", "true"].includes(rest.shift()?.toLowerCase() || ""); task.remark = rest.join(" "); }
    else { task.msgId = rest.shift(); task.remark = rest.join(" "); }
    await store.update(current => {
      const id = (BigInt(current.seq || "0") + 1n).toString();
      task = {...task, id};
      return {...current, schemaVersion: 1, seq: id, tasks: [...current.tasks, task]};
    });
    try { await register(context, task); }
    catch { await store.update(current => ({...current, tasks: current.tasks.filter(item => item.id !== task.id)})); await context.telegram.edit(invocation.message, "无效的 Cron 表达式", {}); return; }
    await context.telegram.edit(invocation.message, `已添加定时任务 <code>${task.id}</code>`, {parseMode: "html"});
  };
  const cronArgs = "CRON 对话 [备注]";
  const cronExample = {args: "send 0 0 2 * * * @target"};
  const acronCommand: CommandDefinition = {
    description: "管理 Cron 定时任务",
    helpOnEmpty: true,
    args: "send|copy|forward|cmd|del|del_re|pin|unpin|list|rm|disable|enable",
    arguments: [{name: "子命令", description: "定时任务类型或管理动作"}],
    subcommandsCaseSensitive: false,
    subcommands: {
      send: {description: "定时发送回复消息的文本", args: cronArgs, examples: [{args: "send 0 0 2 * * * @target 备注"}, {args: "send 0 0 2 * * * @target|回复消息ID 备注"}], handle: createTask("send")},
      copy: {description: "定时复制回复消息到目标对话", args: cronArgs, examples: [{args: "copy 0 0 2 * * * @target 备注"}, {args: "copy 0 0 2 * * * @target|话题ID 备注"}], handle: createTask("copy")},
      forward: {description: "定时转发回复消息到目标对话", args: cronArgs, examples: [{args: "forward 0 0 2 * * * @target 备注"}, {args: "forward 0 0 2 * * * @target|话题ID 备注"}], handle: createTask("forward")},
      cmd: {description: "定时发送换行填写的命令文本", args: cronArgs, examples: [{args: "cmd 0 0 2 * * * me 备注", description: "首行为任务，后续行填写要发送的命令文本"}], handle: createTask("cmd")},
      del: {description: "定时删除指定消息", args: "CRON 对话 消息ID [备注]", examples: [{args: "del 0 0 2 * * * @target 123 [备注]"}], handle: createTask("del")},
      del_re: {description: "定时按正则删除最近消息", args: "CRON 对话 数量 正则 [备注]", examples: [{args: "del_re 0 0 2 * * * @target 100 /^test/i [备注]"}], handle: createTask("del_re")},
      pin: {description: "定时置顶指定消息", args: "CRON 对话 消息ID [通知] [仅自己] [备注]", examples: [{args: "pin 0 0 2 * * * @target 123 true false 备注"}], handle: createTask("pin")},
      unpin: {description: "定时取消置顶指定消息", args: "CRON 对话 消息ID [备注]", examples: [{args: "unpin 0 0 2 * * * @target 123 [备注]"}], handle: createTask("unpin")},
      list: {aliases: ["ls"], description: "列出当前会话中的定时任务", args: "[all] [类型]", examples: [{args: "list"}, {args: "list all"}, {args: "list all del"}], handle: async (invocation, context) => { const all = invocation.args[0] === "all"; return listTasks(invocation, context, all, invocation.args[all ? 1 : 0]); }},
      la: {description: "列出所有定时任务", args: "[类型]", examples: [{args: "la"}, {args: "la del"}], handle: async (invocation, context) => listTasks(invocation, context, true, invocation.args[0])},
      rm: {aliases: ["remove", "del_task"], description: "删除指定定时任务", args: "任务ID", arguments: [{name: "任务ID", required: true, description: "list 中显示的 ID"}], examples: [{args: "rm 1"}], handle: async (invocation, context) => controlTask(invocation, context, "remove")},
      disable: {aliases: ["off"], description: "禁用指定定时任务", args: "任务ID", arguments: [{name: "任务ID", required: true, description: "list 中显示的 ID"}], examples: [{args: "disable 1"}], handle: async (invocation, context) => controlTask(invocation, context, "disable")},
      enable: {aliases: ["on"], description: "启用指定定时任务", args: "任务ID", arguments: [{name: "任务ID", required: true, description: "list 中显示的 ID"}], examples: [{args: "enable 1"}], handle: async (invocation, context) => controlTask(invocation, context, "enable")},
    },
    help: [
      {heading: "▎定时复制", body: "每天2点复制发送到指定对话(可指定话题或回复消息)。\n使用 copy 目标对话 或 目标对话|话题ID/回复消息ID，回复一条消息（可附加备注）。"},
      {heading: "▎定时转发", body: "每天2点转发到指定对话(可指定话题)。\n使用 forward 目标对话 或 目标对话|话题ID，回复一条消息。"},
      {heading: "▎定时发送", body: "保存被回复消息的文本，每天2点在指定对话发送（可指定话题或回复消息）。需要保留媒体与原消息格式时，请使用定时复制/转发功能。"},
      {heading: "▎定时删除", body: "每天2点删除指定ID或@name的对话中的指定ID的消息。"},
      {heading: "▎定时正则删除", body: "每天2点删除指定ID或@name的对话中的最近的 100 条消息中 内容符合正则表达式的消息。"},
      {heading: "▎定时置顶/取消置顶", body: "每天2点在指定ID或@name的对话中置顶指定ID的消息, 是否发通知(true/1, false/0), 是否仅对自己置顶(true/1, false/0)。\n每天2点在指定ID或@name的对话中取消置顶指定ID的消息。"},
      {heading: "▎定时发送命令文本", body: "每天2点向指定ID或@name的对话发送命令文本（可指定话题或回复消息），注意要换行写。插件只确认 Telegram 消息已发送；当前 Core 没有向插件公开命令分发接口，因此不承诺该文本已被执行。\n<pre>{prefix}acron cmd 0 0 2 * * * me 定时备份\n{prefix}bf</pre>\n<pre>{prefix}acron cmd 0 0 2 * * * me 定时状态查询\n{prefix}ping</pre>"},
      {heading: "典型的使用场景:", body: "每天2点发送 <code>{prefix}bf</code> 或 <code>{prefix}ping</code> 等命令文本；是否触发对应命令取决于宿主是否收到并路由该出站消息。"},
      {heading: "Cron 格式：", body: "使用六段表达式：<code>秒 分 时 日 月 星期</code>；时区为 <code>Asia/Shanghai</code>。"},
    ],
    async handle(invocation, context) {
      await context.telegram.edit(invocation.message, renderCommandHelp("acron", acronCommand, {prefix: invocation.prefix}), {parseMode: "html"});
    },
  };
  void cronExample;
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "acron", description: "定时发送、复制、转发、删除及置顶消息",
    renderHelp: prefix => renderCommandHelp("acron", acronCommand, {prefix, title: "定时发送/转发/复制/置顶/取消置顶/删除消息/发送命令文本"}),
    commands: {acron: acronCommand},
    async setup(context) { const state = await context.storage.json<State>("acron_config.json", defaults).update(current => ({...current, schemaVersion: 1, seq: String(current.seq || "0"), tasks: (current.tasks || []).map(task => ({...task, id: String(task.id), chatId: task.chatId === undefined ? undefined : String(task.chatId), delivery: task.delivery || "pending"}))})); for (const task of state.tasks) await register(context, task); },
    async cleanup() {await Promise.all([...disposers.values()].map(dispose => dispose())); disposers.clear();},
  });
}
