import { renderHelp as renderPluginHelp } from "./v2/help";
import { setTimeout as sleep } from "node:timers/promises";
import { returnBigInt } from "teleproto/Helpers";
import { definePlugin, type MessageEnvelope, type PluginContext } from "telebox/sdk";

type Rule = {
  id: string;
  command: string;
  delay: number;
  parameters?: string[];
  deleteResponse?: boolean;
  exactMatch?: boolean;
};
type Pending = { chatId: string; messageId: number; dueAt: number };
type State = {
  schemaVersion: 2;
  enabled: boolean;
  rules: Rule[];
  pending: Record<string, Pending>;
  [key: string]: unknown;
};

const defaultRules = (): Rule[] =>
  [
    ["lang", 10],
    ["alias", 10],
    ["reload", 10],
    ["eat", 10, ["set"]],
    ["tpm", 10],
    ["tpm", 120, ["s", "search", "ls", "i", "install"]],
    ["h", 120, undefined, true],
    ["help", 120, undefined, true],
    ["dc", 120],
    ["ip", 120],
    ["ping", 120],
    ["pingdc", 120],
    ["sysinfo", 120],
    ["whois", 120],
    ["bf", 120],
    ["update", 120],
    ["trace", 120],
    ["service", 120],
    ["s", 120, undefined, true],
    ["speedtest", 120, undefined, true],
    ["spt", 120, undefined, true],
    ["v", 120, undefined, true],
  ].map(([command, delay, parameters, deleteResponse], index) => ({
    id: String(index + 1),
    command: String(command),
    delay: Number(delay),
    ...(parameters ? { parameters: parameters as string[] } : {}),
    ...(deleteResponse ? { deleteResponse: true } : {}),
  }));
const defaults = (): State => ({ schemaVersion: 2, enabled: false, rules: defaultRules(), pending: {} });
const database = (context: PluginContext) => context.storage.json<State>("config.json", defaults());
const key = (chatId: string, messageId: number) => `${chatId}:${messageId}`;
const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

function normalize(input: unknown): State {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const hasV2Rules = Array.isArray(source.rules);
  const hasLegacyRules = Array.isArray(source.customRules);
  const rawRules = hasV2Rules ? (source.rules as unknown[]) : hasLegacyRules ? (source.customRules as unknown[]) : [];
  const rules: Rule[] = rawRules.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const command = String(value.command ?? "")
      .trim()
      .toLowerCase();
    const delay = Number(value.delay);
    if (!/^[a-z0-9_]+$/i.test(command) || !Number.isInteger(delay) || delay < 1 || delay > 86400) return [];
    const parameters = Array.isArray(value.parameters) ? value.parameters.map(String).filter(Boolean) : undefined;
    return [
      {
        id: value.id ? String(value.id) : "",
        command,
        delay,
        ...(parameters?.length ? { parameters } : {}),
        ...(value.deleteResponse === true ? { deleteResponse: true } : {}),
        ...(value.exactMatch === true ? { exactMatch: true } : {}),
      },
    ];
  });
  const legacyV0 = !hasV2Rules && Number(source.configVersion ?? 0) < 1;
  if (legacyV0) {
    const ruleKey = (rule: Rule) =>
      `${rule.command}:${rule.parameters?.join(",") ?? ""}:${rule.exactMatch ? "exact" : "normal"}`;
    for (const fallback of defaultRules()) {
      if (!rules.some(rule => ruleKey(rule) === ruleKey(fallback))) rules.push({ ...fallback, id: "" });
    }
  }
  let nextRuleId = Math.max(0, ...rules.map(rule => Number.parseInt(rule.id, 10)).filter(Number.isFinite)) + 1;
  const usedRuleIds = new Set(rules.filter(rule => rule.id).map(rule => rule.id));
  for (const rule of rules) {
    if (rule.id) continue;
    while (usedRuleIds.has(String(nextRuleId))) nextRuleId++;
    rule.id = String(nextRuleId++);
    usedRuleIds.add(rule.id);
  }
  const pending: Record<string, Pending> = {};
  if (source.pending && typeof source.pending === "object")
    for (const item of Object.values(source.pending as Record<string, unknown>)) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>,
        chatId = String(value.chatId ?? ""),
        messageId = Number(value.messageId),
        dueAt = Number(value.dueAt);
      if (/^-?\d+$/.test(chatId) && Number.isInteger(messageId) && Number.isFinite(dueAt))
        pending[key(chatId, messageId)] = { chatId, messageId, dueAt };
    }
  return {
    ...source,
    ...(legacyV0 ? { configVersion: 1 } : {}),
    schemaVersion: 2,
    enabled: source.enabled === true,
    rules,
    pending,
  };
}

async function forget(context: PluginContext, id: string, running: Set<string>) {
  running.delete(id);
  await database(context).update(state => {
    const pending = { ...state.pending };
    delete pending[id];
    return { ...state, pending };
  });
}
async function deletePending(context: PluginContext, pending: Pending, running: Set<string>) {
  const id = key(pending.chatId, pending.messageId);
  if (running.has(id)) return;
  running.add(id);
  void context.tasks.run(`autodelcmd:${id}`, async signal => {
    try {
      await sleep(Math.max(0, pending.dueAt - Date.now()), undefined, { signal });
      signal.throwIfAborted();
      await context.telegram.withClient(async (client, telegramSignal) => {
        signal.throwIfAborted();
        telegramSignal.throwIfAborted();
        await client.deleteMessages(returnBigInt(pending.chatId), [pending.messageId], { revoke: true });
      });
    } catch {
      if (!signal.aborted) context.log.error("autodelcmd:delete_failed");
    } finally {
      if (!signal.aborted) await forget(context, id, running);
      else running.delete(id);
    }
  });
}
async function queue(context: PluginContext, chatId: string, messageId: number, delay: number, running: Set<string>) {
  const item = { chatId, messageId, dueAt: Date.now() + delay * 1000 };
  await database(context).update(state => ({
    ...state,
    pending: { ...state.pending, [key(chatId, messageId)]: item },
  }));
  await deletePending(context, item, running);
}
function match(rules: Rule[], command: string, args: readonly string[]): Rule | undefined {
  return (
    rules.find(rule => rule.command === command && rule.parameters?.includes(args[0] ?? "")) ??
    (args.length === 0
      ? rules.find(rule => rule.command === command && !rule.parameters?.length && rule.exactMatch)
      : undefined) ??
    rules.find(rule => rule.command === command && !rule.parameters?.length && !rule.exactMatch)
  );
}
async function responseIds(context: PluginContext, message: MessageEnvelope): Promise<number[]> {
  return context.telegram.withClient(async client => {
    const messages: any[] = await client.getMessages(returnBigInt(message.chatId), { limit: 100 });
    return messages
      .filter(value => value.id !== message.id && value.id > message.id && (message.saved || value.out))
      .slice(0, 3)
      .map(value => value.id);
  });
}
function nextId(rules: Rule[]) {
  return String(Math.max(0, ...rules.map(rule => Number(rule.id)).filter(Number.isFinite)) + 1);
}

export default function createPlugin() {
  const running = new Set<string>();
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "autodelcmd",
    description: "按规则延迟删除命令及其响应。",
    commands: {
      autodelcmd: {
        helpArgs: ["help", "h"],
        helpOnEmpty: true,
        description: "管理命令自动删除规则",
        async handle({ message, args, prefix }, context) {
          const action = args[0]?.toLowerCase();
          const state = await database(context).read();
          if (["on", "enable"].includes(action)) {
            await database(context).update(value => ({ ...value, enabled: true }));
            await context.telegram.edit(message, "🟢 自动删除功能已启用");
            return;
          }
          if (["off", "disable"].includes(action)) {
            await database(context).update(value => ({ ...value, enabled: false }));
            await context.telegram.edit(message, "🔴 自动删除功能已禁用");
            return;
          }
          if (["status", "st"].includes(action)) {
            await context.telegram.edit(
              message,
              `${state.enabled ? "🟢 已启用" : "🔴 已禁用"}\n规则数：${state.rules.length}\n待删除：${Object.keys(state.pending).length}`,
            );
            return;
          }
          if (["list", "ls"].includes(action)) {
            const body = state.rules
              .map(
                (rule, index) =>
                  `${index + 1}. <code>${escape(rule.command)}${rule.parameters?.length ? ` [${rule.parameters.map(escape).join(", ")}]` : ""}</code> → ${rule.delay}秒${rule.deleteResponse ? " 🔄" : ""}${rule.exactMatch ? " 🎯" : ""} <code>[ID: ${escape(rule.id)}]</code>`,
              )
              .join("\n");
            await context.telegram.edit(message, body ? `📋 <b>自动删除规则</b>\n\n${body}` : "暂无规则", {
              parseMode: "html",
            });
            return;
          }
          if (action === "reset") {
            await database(context).update(value => ({ ...defaults(), pending: { ...value.pending } }));
            await context.telegram.edit(message, `✅ 已重置为默认配置，共 ${defaultRules().length} 条规则`);
            return;
          }
          if (action === "add") {
            const values = args.slice(1),
              response = values.includes("-r") || values.includes("--response"),
              exact = values.includes("-e") || values.includes("--exact");
            const filtered = values.filter(value => !["-r", "--response", "-e", "--exact"].includes(value));
            const command = filtered[0]?.toLowerCase(),
              delay = Number(filtered[1]),
              parameters = filtered.slice(2);
            if (
              !command ||
              !/^[a-z0-9_]+$/i.test(command) ||
              !Number.isInteger(delay) ||
              delay < 1 ||
              delay > 86400 ||
              (exact && parameters.length)
            ) {
              await context.telegram.edit(
                message,
                `❌ 用法：<code>${prefix}autodelcmd add [命令] [1-86400秒] [参数...] [-r] [-e]</code>`,
                { parseMode: "html" },
              );
              return;
            }
            let conflictId: string | undefined;
            await database(context).update(value => {
              const rules = value.rules.map(rule => ({
                ...rule,
                ...(rule.parameters ? { parameters: [...rule.parameters] } : {}),
              }));
              const conflict = rules.find(
                rule =>
                  rule.command === command &&
                  !!rule.exactMatch === exact &&
                  (!parameters.length
                    ? !rule.parameters?.length
                    : parameters.some(parameter => rule.parameters?.includes(parameter))),
              );
              if (conflict && (conflict.delay !== delay || !!conflict.deleteResponse !== response)) {
                conflictId = conflict.id;
                return value;
              }
              const merge = rules.find(
                rule =>
                  rule.command === command &&
                  rule.delay === delay &&
                  !!rule.deleteResponse === response &&
                  !!rule.exactMatch === exact,
              );
              if (merge && parameters.length)
                merge.parameters = [...new Set([...(merge.parameters ?? []), ...parameters])];
              else {
                const retained = parameters.length
                  ? rules
                  : rules.filter(
                      rule => !(rule.command === command && !rule.parameters?.length && !!rule.exactMatch === exact),
                    );
                retained.push({
                  id: nextId(retained),
                  command,
                  delay,
                  ...(parameters.length ? { parameters } : {}),
                  ...(response ? { deleteResponse: true } : {}),
                  ...(exact ? { exactMatch: true } : {}),
                });
                return { ...value, rules: retained };
              }
              return { ...value, rules };
            });
            if (conflictId) {
              await context.telegram.edit(message, `❌ 规则冲突，请先删除 ID ${escape(conflictId)}`, {
                parseMode: "html",
              });
              return;
            }
            await context.telegram.edit(message, "✅ 已保存自动删除规则");
            return;
          }
          if (["del", "remove"].includes(action)) {
            const target = args[1];
            if (!target) {
              await context.telegram.edit(message, `❌ 用法：<code>${prefix}autodelcmd del [规则ID或命令名]</code>`, {
                parseMode: "html",
              });
              return;
            }
            let removed = false;
            await database(context).update(value => {
              if (!value.rules.some(rule => rule.id === target)) return value;
              removed = true;
              return { ...value, rules: value.rules.filter(rule => rule.id !== target) };
            });
            if (removed) {
              await context.telegram.edit(message, "✅ 已删除自动删除规则");
              return;
            }
            const matches = (await database(context).read()).rules.filter(
              rule => rule.command === target.toLowerCase(),
            );
            if (!matches.length) {
              await context.telegram.edit(message, `❌ 未找到规则 ID 或命令 ${escape(target)}`, { parseMode: "html" });
              return;
            }
            const body = matches
              .map(
                (rule, index) =>
                  `${index + 1}. <code>${escape(rule.command)}${rule.parameters?.length ? ` [${rule.parameters.map(escape).join(", ")}]` : ""}</code> → ${rule.delay}秒${rule.deleteResponse ? " 🔄" : ""}${rule.exactMatch ? " 🎯" : ""} <code>[ID: ${escape(rule.id)}]</code>`,
              )
              .join("\n");
            await context.telegram.edit(message, `📋 <b>命令 “${escape(target)}” 的自动删除规则</b>\n\n${body}`, {
              parseMode: "html",
            });
            return;
          }
          await context.telegram.edit(
            message,
            `<b>自动删除命令消息</b>\n<code>${prefix}autodelcmd on|off|status|list|add|del|reset</code>`,
            { parseMode: "html" },
          );
        },
      },
    },
    listeners: [
      {
        edited: false,
        ignoreCommands: false,
        async handle(message, context) {
          if ((!message.outgoing && !message.saved) || !message.text) return;
          const state = await database(context).read();
          if (!state.enabled) return;
          const route = context.commands.parse(message.text);
          if (!route) return;
          const rule = match(state.rules, route.command, route.args);
          if (!rule) return;
          const ids = rule.deleteResponse ? await responseIds(context, message) : [];
          for (const id of [...ids, message.id]) await queue(context, message.chatId, id, rule.delay, running);
        },
      },
    ],
    async setup(context) {
      const legacy = await database(context).read();
      const state = normalize(legacy);
      await database(context).update(() => state);
      for (const pending of Object.values(state.pending)) await deletePending(context, pending, running);
    },
    cleanup() {
      running.clear();
    },
  });
}
