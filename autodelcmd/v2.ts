import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {setTimeout as sleep} from "node:timers/promises";
import {returnBigInt} from "teleproto/Helpers";

type Rule = {id: string; command: string; delay: number; parameters?: string[]; deleteResponse?: boolean; exactMatch?: boolean};
type Pending = {chatId: string; messageId: number; dueAt: number};
type State = {schemaVersion: 2; enabled: boolean; rules: Rule[]; pending: Record<string, Pending>; [key: string]: unknown};

const defaultRules = (): Rule[] => [
  ["lang", 10], ["alias", 10], ["reload", 10], ["eat", 10, ["set"]], ["tpm", 10],
  ["tpm", 120, ["s", "search", "ls", "i", "install"]], ["h", 120, undefined, true],
  ["help", 120, undefined, true], ["dc", 120], ["ip", 120], ["ping", 120], ["pingdc", 120],
  ["sysinfo", 120], ["whois", 120], ["bf", 120], ["update", 120], ["trace", 120], ["service", 120],
  ["s", 120, undefined, true], ["speedtest", 120, undefined, true], ["spt", 120, undefined, true], ["v", 120, undefined, true],
].map(([command, delay, parameters, deleteResponse], index) => ({
  id: String(index + 1), command: String(command), delay: Number(delay),
  ...(parameters ? {parameters: parameters as string[]} : {}), ...(deleteResponse ? {deleteResponse: true} : {}),
}));
const defaults = (): State => ({schemaVersion: 2, enabled: false, rules: defaultRules(), pending: {}});
const database = (context: PluginContext) => context.storage.json<State>("config.json", defaults());
const key = (chatId: string, messageId: number) => `${chatId}:${messageId}`;
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!));

function normalize(input: unknown): State {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rawRules = Array.isArray(source.rules) ? source.rules : Array.isArray(source.customRules) ? source.customRules : defaultRules();
  const rules: Rule[] = rawRules.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const command = String(value.command ?? "").trim().toLowerCase();
    const delay = Number(value.delay);
    if (!/^[a-z0-9_]+$/i.test(command) || !Number.isInteger(delay) || delay < 1 || delay > 86400) return [];
    const parameters = Array.isArray(value.parameters) ? value.parameters.map(String).filter(Boolean) : undefined;
    return [{id: String(value.id ?? index + 1), command, delay, ...(parameters?.length ? {parameters} : {}),
      ...(value.deleteResponse === true ? {deleteResponse: true} : {}), ...(value.exactMatch === true ? {exactMatch: true} : {})}];
  });
  const pending: Record<string, Pending> = {};
  if (source.pending && typeof source.pending === "object") for (const item of Object.values(source.pending as Record<string, unknown>)) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>, chatId = String(value.chatId ?? ""), messageId = Number(value.messageId), dueAt = Number(value.dueAt);
    if (/^-?\d+$/.test(chatId) && Number.isInteger(messageId) && Number.isFinite(dueAt)) pending[key(chatId, messageId)] = {chatId, messageId, dueAt};
  }
  return {...source, schemaVersion: 2, enabled: source.enabled === true, rules, pending};
}
async function forget(context: PluginContext, id: string, running: Set<string>) {
  running.delete(id);
  await database(context).update(state => { const pending = {...state.pending}; delete pending[id]; return {...state, pending}; });
}
async function deletePending(context: PluginContext, pending: Pending, running: Set<string>) {
  const id = key(pending.chatId, pending.messageId);
  if (running.has(id)) return;
  running.add(id);
  void context.tasks.run(`autodelcmd:${id}`, async signal => {
    try {
      await sleep(Math.max(0, pending.dueAt - Date.now()), undefined, {signal});
      await context.telegram.withClient(async client => client.deleteMessages(returnBigInt(pending.chatId), [pending.messageId], {revoke: true}));
    } catch (error) {
      if (!signal.aborted) context.log.error("autodelcmd:delete", {error: String(error).slice(0, 300)});
    } finally {
      if (!signal.aborted) await forget(context, id, running);
      else running.delete(id);
    }
  });
}
async function queue(context: PluginContext, chatId: string, messageId: number, delay: number, running: Set<string>) {
  const item = {chatId, messageId, dueAt: Date.now() + delay * 1000};
  await database(context).update(state => ({...state, pending: {...state.pending, [key(chatId, messageId)]: item}}));
  await deletePending(context, item, running);
}
function match(rules: Rule[], command: string, args: readonly string[]): Rule | undefined {
  return rules.find(rule => rule.command === command && rule.parameters?.includes(args[0] ?? ""))
    ?? rules.find(rule => rule.command === command && !rule.parameters?.length && (!rule.exactMatch || args.length === 0));
}
async function responseIds(context: PluginContext, message: MessageEnvelope): Promise<number[]> {
  return context.telegram.withClient(async client => {
    const messages: any[] = await client.getMessages(returnBigInt(message.chatId), {limit: 100});
    return messages.filter(value => value.id !== message.id && value.id > message.id && (message.saved || value.out)).slice(0, 3).map(value => value.id);
  });
}
function nextId(rules: Rule[]) { return String(Math.max(0, ...rules.map(rule => Number(rule.id)).filter(Number.isFinite)) + 1); }

export default function createPlugin() {
  const running = new Set<string>();
  const toggle = (enabled: boolean) => async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    await database(context).update(value => ({...value, enabled}));
    await context.telegram.edit(invocation.message, enabled ? "🟢 自动删除功能已启用" : "🔴 自动删除功能已禁用");
  };
  const status = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const state = await database(context).read();
    await context.telegram.edit(invocation.message, `${state.enabled ? "🟢 已启用" : "🔴 已禁用"}\n规则数：${state.rules.length}\n待删除：${Object.keys(state.pending).length}`);
  };
  const list = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const state = await database(context).read();
    const body = state.rules.map((rule, index) => `${index + 1}. <code>${escape(rule.command)}${rule.parameters?.length ? ` [${rule.parameters.map(escape).join(", ")}]` : ""}</code> → ${rule.delay}秒${rule.deleteResponse ? " 🔄" : ""}${rule.exactMatch ? " 🎯" : ""} <code>[ID: ${escape(rule.id)}]</code>`).join("\n");
    await context.telegram.edit(invocation.message, body ? `📋 <b>自动删除规则</b>\n\n${body}` : "暂无规则", {parseMode: "html"});
  };
  const reset = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    await database(context).update(() => defaults());
    await context.telegram.edit(invocation.message, `✅ 已重置为默认配置，共 ${defaultRules().length} 条规则`);
  };
  const add = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const values = invocation.args, response = values.includes("-r") || values.includes("--response"), exact = values.includes("-e") || values.includes("--exact");
    const filtered = values.filter(value => !["-r", "--response", "-e", "--exact"].includes(value));
    const command = filtered[0]?.toLowerCase(), delay = Number(filtered[1]), parameters = filtered.slice(2);
    if (!command || !/^[a-z0-9_]+$/i.test(command) || !Number.isInteger(delay) || delay < 1 || delay > 86400 || (exact && parameters.length)) {
      await context.telegram.edit(invocation.message, `❌ 用法：<code>${invocation.prefix}autodelcmd add [命令] [1-86400秒] [参数...] [-r] [-e]</code>`, {parseMode: "html"}); return;
    }
    let conflictId: string | undefined;
    await database(context).update(value => {
      const rules = [...value.rules];
      const conflict = rules.find(rule => rule.command === command && !!rule.exactMatch === exact && (!parameters.length ? !rule.parameters?.length : parameters.some(parameter => rule.parameters?.includes(parameter))));
      if (conflict && (conflict.delay !== delay || !!conflict.deleteResponse !== response)) {
        conflictId = conflict.id;
        return value;
      }
      const merge = rules.find(rule => rule.command === command && rule.delay === delay && !!rule.deleteResponse === response && !!rule.exactMatch === exact);
      if (merge && parameters.length) merge.parameters = [...new Set([...(merge.parameters ?? []), ...parameters])];
      else rules.push({id: nextId(rules), command, delay, ...(parameters.length ? {parameters} : {}), ...(response ? {deleteResponse: true} : {}), ...(exact ? {exactMatch: true} : {})});
      return {...value, rules};
    });
    if (conflictId) { await context.telegram.edit(invocation.message, `❌ 规则冲突，请先删除 ID ${escape(conflictId)}`, {parseMode: "html"}); return; }
    await context.telegram.edit(invocation.message, "✅ 已保存自动删除规则");
  };
  const del = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const target = invocation.args[0];
    const state = await database(context).read();
    if (!target) { await context.telegram.edit(invocation.message, `❌ 用法：<code>${invocation.prefix}autodelcmd del [规则ID]</code>`, {parseMode: "html"}); return; }
    if (!state.rules.some(rule => rule.id === target)) { await context.telegram.edit(invocation.message, `❌ 未找到规则 ID ${escape(target)}`, {parseMode: "html"}); return; }
    await database(context).update(value => ({...value, rules: value.rules.filter(rule => rule.id !== target)}));
    await context.telegram.edit(invocation.message, "✅ 已删除自动删除规则");
  };
  const autodelcmd: CommandDefinition = {
    description: "管理命令自动删除规则",
    helpArgs: ["help", "h"],
    helpOnEmpty: true,
    args: "on|off|status|list|add|del|reset",
    arguments: [
      {name: "on|off", description: "开启或关闭新任务；别名 enable / disable"},
      {name: "status", description: "查看开关、规则数和待删除数；别名 st"},
      {name: "list", description: "查看规则、延迟、选项和 ID；别名 ls"},
      {name: "add", description: "格式：add 命令 延迟秒数 [参数...] [-r] [-e]"},
      {name: "del", description: "按列表中的 ID 删除规则；del 也可写 remove"},
      {name: "reset", description: "恢复默认规则并关闭功能"},
    ],
    examples: [{args: "list"}, {args: "add calc 45 -e"}, {args: "on"}, {args: "del 1"}],
    help: [
      {heading: "参数与匹配：", body: "• 命令名填写字母、数字或下划线，不带前缀。执行时使用当前配置的前缀，命令别名按路由解析后的命令匹配。\n• 延迟为 1–86400 的整数，单位秒。\n• 多个“参数”表示允许的第一个参数；参数值区分大小写。\n• 带参数的规则优先于通用规则，匹配后使用第一条适用规则。\n• <code>-e</code> / <code>--exact</code>：只匹配无参数调用，不能同时填写参数列表。\n• <code>-r</code> / <code>--response</code>：从最近 100 条消息中选择 ID 大于命令的消息，最多 3 条。"},
      {heading: "任务与常见提示：", body: "• 关闭功能或删除规则只影响后续匹配；已经排定的删除仍可能执行。\n• 待删除任务会持久保存，重启后继续处理保留的任务。\n• “规则冲突”会给出 ID，先核对并删除该条规则，再添加新配置。\n• 删除能力受当前对话的 Telegram 权限限制。"},
    ],
    subcommandsCaseSensitive: false,
    subcommands: {
      on: {aliases: ["enable"], description: "开启自动删除功能", args: "", examples: [{args: "on"}], handle: toggle(true)},
      off: {aliases: ["disable"], description: "关闭自动删除功能", args: "", examples: [{args: "off"}], handle: toggle(false)},
      status: {aliases: ["st"], description: "查看开关、规则数和待删除数", args: "", examples: [{args: "status"}], handle: status},
      list: {aliases: ["ls"], description: "查看规则、延迟、选项和 ID", args: "", examples: [{args: "list"}], handle: list},
      reset: {description: "恢复默认规则并关闭功能", args: "", examples: [{args: "reset"}], handle: reset},
      add: {description: "添加或合并一条规则", args: "命令 延迟秒数 [参数...] [-r] [-e]", arguments: [{name: "命令", required: true, description: "不带前缀的命令名"}, {name: "延迟秒数", required: true, description: "1–86400 的整数"}, {name: "参数...", description: "允许的第一个参数，多个用空格分隔"}, {name: "-r|--response", description: "同时删除命令的响应消息"}, {name: "-e|--exact", description: "只匹配无参数调用"}], examples: [{args: "add calc 45 -e"}], handle: add},
      del: {aliases: ["remove"], description: "按 ID 删除规则", args: "规则ID", arguments: [{name: "规则ID", required: true, description: "list 中显示的 ID"}], examples: [{args: "del 1"}], handle: del},
    },
    async handle(invocation, context) {
      await context.telegram.edit(invocation.message, `<b>自动删除命令消息</b>\n<code>${invocation.prefix}autodelcmd on|off|status|list|add|del|reset</code>`, {parseMode: "html"});
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "autodelcmd", description: "按规则延迟删除命令及其响应。",
    renderHelp: prefix => renderCommandHelp("autodelcmd", autodelcmd, {prefix, title: "🗑️ 命令自动删除"}),
    commands: {autodelcmd},
    listeners: [{edited: false, ignoreCommands: false, direction: "outgoing", includeSaved: true, async handle(message, context) {
      if (!message.text) return;
      const state = await database(context).read(); if (!state.enabled) return;
      const route = context.commands.parse(message.text); if (!route || route.command === "autodelcmd") return;
      const rule = match(state.rules, route.command, route.args); if (!rule) return;
      const ids = rule.deleteResponse ? await responseIds(context, message) : [];
      for (const id of [...ids, message.id]) await queue(context, message.chatId, id, rule.delay, running);
    }}],
    async setup(context) {
      const legacy = await database(context).read(); const state = normalize(legacy);
      await database(context).update(() => state);
      for (const pending of Object.values(state.pending)) await deletePending(context, pending, running);
    },
    cleanup() { running.clear(); },
  });
}
