import {setTimeout as sleep} from "node:timers/promises";
import {returnBigInt} from "teleproto/Helpers";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";

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

const running = new Set<string>();
async function forget(context: PluginContext, id: string) {
  running.delete(id);
  await database(context).update(state => { const pending = {...state.pending}; delete pending[id]; return {...state, pending}; });
}
async function deletePending(context: PluginContext, pending: Pending) {
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
      if (!signal.aborted) await forget(context, id);
      else running.delete(id);
    }
  });
}
async function queue(context: PluginContext, chatId: string, messageId: number, delay: number) {
  const item = {chatId, messageId, dueAt: Date.now() + delay * 1000};
  await database(context).update(state => ({...state, pending: {...state.pending, [key(chatId, messageId)]: item}}));
  await deletePending(context, item);
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

export default function createPlugin() { return definePlugin({
  apiVersion: 1, id: "autodelcmd", description: "按规则延迟删除命令及其响应。",
  commands: {autodelcmd: {description: "管理命令自动删除规则", async handle({message, args, prefix}, context) {
    const action = args[0]?.toLowerCase();
    const state = await database(context).read();
    if (["on", "enable"].includes(action)) { await database(context).update(value => ({...value, enabled: true})); await context.telegram.edit(message, "🟢 自动删除功能已启用"); return; }
    if (["off", "disable"].includes(action)) { await database(context).update(value => ({...value, enabled: false})); await context.telegram.edit(message, "🔴 自动删除功能已禁用"); return; }
    if (["status", "st"].includes(action)) { await context.telegram.edit(message, `${state.enabled ? "🟢 已启用" : "🔴 已禁用"}\n规则数：${state.rules.length}\n待删除：${Object.keys(state.pending).length}`); return; }
    if (["list", "ls"].includes(action)) {
      const body = state.rules.map((rule, index) => `${index + 1}. <code>${escape(rule.command)}${rule.parameters?.length ? ` [${rule.parameters.map(escape).join(", ")}]` : ""}</code> → ${rule.delay}秒${rule.deleteResponse ? " 🔄" : ""}${rule.exactMatch ? " 🎯" : ""} <code>[ID: ${escape(rule.id)}]</code>`).join("\n");
      await context.telegram.edit(message, body ? `📋 <b>自动删除规则</b>\n\n${body}` : "暂无规则", {parseMode: "html"}); return;
    }
    if (action === "reset") { await database(context).update(() => defaults()); await context.telegram.edit(message, `✅ 已重置为默认配置，共 ${defaultRules().length} 条规则`); return; }
    if (action === "add") {
      const values = args.slice(1), response = values.includes("-r") || values.includes("--response"), exact = values.includes("-e") || values.includes("--exact");
      const filtered = values.filter(value => !["-r", "--response", "-e", "--exact"].includes(value));
      const command = filtered[0]?.toLowerCase(), delay = Number(filtered[1]), parameters = filtered.slice(2);
      if (!command || !/^[a-z0-9_]+$/i.test(command) || !Number.isInteger(delay) || delay < 1 || delay > 86400 || (exact && parameters.length)) {
        await context.telegram.edit(message, `❌ 用法：<code>${prefix}autodelcmd add [命令] [1-86400秒] [参数...] [-r] [-e]</code>`, {parseMode: "html"}); return;
      }
      const conflict = state.rules.find(rule => rule.command === command && !!rule.exactMatch === exact && (!parameters.length ? !rule.parameters?.length : parameters.some(value => rule.parameters?.includes(value))));
      if (conflict && (conflict.delay !== delay || !!conflict.deleteResponse !== response)) { await context.telegram.edit(message, `❌ 规则冲突，请先删除 ID ${escape(conflict.id)}`, {parseMode: "html"}); return; }
      await database(context).update(value => {
        const rules = [...value.rules];
        const merge = rules.find(rule => rule.command === command && rule.delay === delay && !!rule.deleteResponse === response && !!rule.exactMatch === exact);
        if (merge && parameters.length) merge.parameters = [...new Set([...(merge.parameters ?? []), ...parameters])];
        else rules.push({id: nextId(rules), command, delay, ...(parameters.length ? {parameters} : {}), ...(response ? {deleteResponse: true} : {}), ...(exact ? {exactMatch: true} : {})});
        return {...value, rules};
      });
      await context.telegram.edit(message, "✅ 已保存自动删除规则"); return;
    }
    if (["del", "remove"].includes(action)) {
      const target = args[1];
      if (!target) { await context.telegram.edit(message, `❌ 用法：<code>${prefix}autodelcmd del [规则ID]</code>`, {parseMode: "html"}); return; }
      const exists = state.rules.some(rule => rule.id === target);
      if (!exists) { await context.telegram.edit(message, `❌ 未找到规则 ID ${escape(target)}`, {parseMode: "html"}); return; }
      await database(context).update(value => ({...value, rules: value.rules.filter(rule => rule.id !== target)}));
      await context.telegram.edit(message, "✅ 已删除自动删除规则"); return;
    }
    await context.telegram.edit(message, `<b>自动删除命令消息</b>\n<code>${prefix}autodelcmd on|off|status|list|add|del|reset</code>`, {parseMode: "html"});
  }}},
  listeners: [{edited: false, ignoreCommands: false, async handle(message, context) {
    if ((!message.outgoing && !message.saved) || !message.text) return;
    const state = await database(context).read(); if (!state.enabled) return;
    const route = context.commands.parse(message.text); if (!route || route.command === "autodelcmd") return;
    const rule = match(state.rules, route.command, route.args); if (!rule) return;
    const ids = rule.deleteResponse ? await responseIds(context, message) : [];
    for (const id of [...ids, message.id]) await queue(context, message.chatId, id, rule.delay);
  }}],
  async setup(context) {
    const legacy = await database(context).read(); const state = normalize(legacy);
    await database(context).update(() => state);
    for (const pending of Object.values(state.pending)) await deletePending(context, pending);
  },
  cleanup() { running.clear(); },
}); }
