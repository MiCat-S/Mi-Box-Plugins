import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

type Target = {id: string; target: string; chatId?: string; topicId?: string; display?: string; status?: "0"; createdAt: string; updatedAt?: string; [key: string]: unknown};
type State = {schemaVersion: number; seq: string; mode: "sequence" | "broadcast"; targets: Target[]; [key: string]: unknown};
const defaults = (): State => ({schemaVersion: 1, seq: "0", mode: "sequence", targets: []});
const store = (context: PluginContext) => context.storage.json<State>("config.json", defaults());
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function normalize(source: State): State {
  const targets = Array.isArray(source.targets) ? source.targets.filter(value => value && typeof value.target === "string").map(value => {
    const next: Target = {...value, id: String(value.id), target: String(value.target), createdAt: String(value.createdAt ?? Date.now())};
    if (value.chatId === undefined) delete next.chatId; else next.chatId = String(value.chatId);
    if (value.topicId === undefined) delete next.topicId; else next.topicId = String(value.topicId);
    return next;
  }) : [];
  const maximum = targets.reduce((max, value) => Math.max(max, Number(value.id) || 0), 0);
  return {...source, schemaVersion: 1, seq: String(Math.max(maximum, Number(source.seq) || 0)),
    mode: source.mode === "broadcast" ? "broadcast" : "sequence", targets};
}
function lookup(target: Target): string | bigint {
  const value = target.chatId ?? target.target;
  if (/^-?\d+$/.test(value)) return BigInt(value);
  return value;
}
function list(state: State): string {
  const rows = state.targets.slice().sort((a, b) => Number(a.id) - Number(b.id)).map(value =>
    `${value.status === "0" ? "⏹" : "🔛"} [<code>${escape(value.id)}</code>] ${value.display || `<code>${escape(value.target)}</code>`}` +
    (value.topicId ? ` | 话题 <code>${escape(value.topicId)}</code>` : ""));
  return `<b>保送目标</b>\n模式：<b>${state.mode === "broadcast" ? "群发" : "顺序"}</b>\n\n${rows.join("\n") || "暂无目标"}`;
}
function forwarded(result: any): any[] {
  return Array.isArray(result?.updates) ? result.updates.map((value: any) => value?.message).filter((value: any) => value?.className === "Message") : [];
}

async function forward(invocation: CommandInvocation, context: PluginContext, count: number): Promise<void> {
  const reply = await context.telegram.getReply(invocation.message);
  if (!reply) { await context.telegram.edit(invocation.message, "请回复需要保送的消息"); return; }
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) { await context.telegram.edit(invocation.message, "消息数必须是 1 到 100 的整数"); return; }
  const state = normalize(await store(context).read());
  const targets = state.targets.filter(value => value.status !== "0");
  if (!targets.length) { await context.telegram.edit(invocation.message, "尚未配置可用目标"); return; }
  await context.telegram.edit(invocation.message, "正在保送消息…");
  try {
    const successes: string[] = [];
    const failures: string[] = [];
    await context.telegram.withClient(async (client, signal) => {
      const {Api} = await import("teleproto");
      const raw = invocation.message.raw as ApiTypes.Message | undefined;
      const replied = reply.raw as ApiTypes.Message | undefined;
      if (!raw?.peerId || !replied) throw new Error("Missing source");
      const values: any[] = [];
      for (let id = replied.id; values.length < count && id < replied.id + count * 3; id++) {
        signal.throwIfAborted();
        const result = await client.getMessages(raw.peerId, {ids: [id]});
        const message = Array.isArray(result) ? result[0] : result;
        if (message?.id) values.push(message.id);
      }
      if (!values.length) throw new Error("No messages");
      for (const target of targets) {
        signal.throwIfAborted();
        try {
          const entity: any = await client.getEntity(lookup(target) as any);
          const input = await client.getInputEntity(entity);
          const result = await client.invoke(new Api.messages.ForwardMessages({fromPeer: raw.peerId, id: values, toPeer: input,
            ...(target.topicId && /^\d+$/.test(target.topicId) ? {topMsgId: Number(target.topicId)} : {})}));
          const messages = forwarded(result);
          successes.push(`${target.display || target.target}（${messages.length || values.length} 条）`);
          if (state.mode === "sequence") break;
        } catch { failures.push(target.display || target.target); }
      }
    });
    if (!successes.length) { await context.telegram.edit(invocation.message, `保送失败${failures.length ? `：${failures.map(escape).join("、")}` : ""}`); return; }
    await context.telegram.edit(invocation.message, `已保送至：${successes.map(escape).join("、")}`);
  } catch {
    if (context.signal.aborted) return;
    context.log.error("bs_forward_failed");
    await context.telegram.edit(invocation.message, "保送失败，请检查目标权限或稍后重试");
  }
}

export default function createBs() {
  const add: CommandDefinition = {
    description: "添加目标（支持 |话题ID）", args: "对话[|话题ID]",
    arguments: [{name: "对话", required: true, description: "对话 ID 或 @用户名"}, {name: "话题ID", description: "可选，用 | 分隔"}],
    examples: [{args: "add 123456789"}, {args: "add @channel|42"}],
    handle: async (invocation, context) => {
      const rawTarget = invocation.args.join(" ").trim();
      const [target, topicId] = rawTarget.split(/\s*[|｜]\s*/, 2);
      if (!target) { await context.telegram.edit(invocation.message, "请提供目标对话"); return; }
      try {
        let resolved: any;
        await context.telegram.withClient(async client => { resolved = await client.getEntity((/^-?\d+$/.test(target) ? BigInt(target) : target) as never); });
        const state = await store(context).update(source => {
          const value = normalize(source); const id = String(Number(value.seq) + 1); value.seq = id;
          const entry: Target = {id, target,
            display: resolved?.title || [resolved?.firstName, resolved?.lastName].filter(Boolean).join(" ") || resolved?.username && `@${resolved.username}` || target,
            createdAt: String(Date.now())};
          if (resolved?.id?.toString() !== undefined) entry.chatId = String(resolved.id);
          if (/^\d+$/.test(topicId ?? "")) entry.topicId = topicId;
          value.targets.push(entry); return value;
        });
        await context.telegram.edit(invocation.message, `目标 <code>${state.seq}</code> 已添加`, {parseMode: "html"});
      } catch { await context.telegram.edit(invocation.message, "无法解析目标对话"); }
    },
  };
  const listCommand: CommandDefinition = {
    description: "列出所有目标", args: "",
    examples: [{args: "list"}],
    handle: async (invocation, context) => { await context.telegram.edit(invocation.message, list(normalize(await store(context).read())), {parseMode: "html", linkPreview: false}); },
  };
  const control = (action: "remove" | "on" | "off"): CommandDefinition => ({
    description: action === "remove" ? "移除指定目标" : action === "on" ? "启用指定目标" : "禁用指定目标",
    args: "ID", arguments: [{name: "ID", required: true, description: "目标列表中的 ID"}],
    examples: [{args: `${action === "remove" ? "del" : action === "on" ? "enable" : "disable"} 1`}],
    handle: async (invocation, context) => {
      const id = invocation.args[0];
      if (!id) { await context.telegram.edit(invocation.message, renderCommandHelp("bs", bsCommand, {prefix: invocation.prefix, title: "保送插件"}), {parseMode: "html"}); return; }
      let found = false;
      await store(context).update(source => { const state = normalize(source); const target = state.targets.find(value => value.id === id);
        if (!target) return state; found = true;
        if (action === "remove") state.targets = state.targets.filter(value => value.id !== id);
        else if (action === "off") target.status = "0"; else delete target.status;
        return state; });
      await context.telegram.edit(invocation.message, found ? "目标状态已更新" : "目标不存在");
    },
  });
  const toggle: CommandDefinition = {
    description: "切换发送模式（顺序 / 群发）", args: "",
    subcommandsCaseSensitive: false,
    subcommands: {mode: {
      description: "切换发送模式（顺序 / 群发）", args: "",
      examples: [{args: "mode"}],
      async handle(invocation, context) {
        const state = await store(context).update(source => { const value = normalize(source); value.mode = value.mode === "sequence" ? "broadcast" : "sequence"; return value; });
        await context.telegram.edit(invocation.message, `模式已切换为${state.mode === "broadcast" ? "群发" : "顺序"}`);
      },
    }},
    examples: [{args: "toggle mode"}],
    handle: async (invocation, context) => {
      await context.telegram.edit(invocation.message, renderCommandHelp("bs", bsCommand, {prefix: invocation.prefix, title: "保送插件"}), {parseMode: "html"});
    },
  };
  const bsCommand: CommandDefinition = {
    description: "管理目标或保送回复消息",
    helpArgs: ["help", "h", "说明"],
    args: "[消息数]",
    arguments: [{name: "消息数", description: "可选；回复一条消息后转发 1–100 条，默认 1"}],
    examples: [{args: ""}, {args: "3"}, {args: "add @channel|42"}, {args: "list"}, {args: "toggle mode"}],
    subcommandsCaseSensitive: false,
    subcommands: {add, list: {...listCommand, aliases: ["ls"]}, del: {...control("remove"), aliases: ["rm"]}, enable: {...control("on"), aliases: ["on"]}, disable: {...control("off"), aliases: ["off"]}, toggle},
    help: [
      {heading: "说明：", body: "使用 <code>{prefix}bs [消息数]</code> 回复一条消息即可保送。首次使用请先 <code>{prefix}bs add</code> 配置转发目标；默认顺序模式按顺序优先发送，成功后不再继续；toggle mode 切换为每个目标都尝试发送。"},
    ],
    async handle(invocation, context) {
      const command = (invocation.args[0] ?? "").toLowerCase();
      if (!command || /^\d+$/.test(command)) return forward(invocation, context, command ? Number(command) : 1);
      await context.telegram.edit(invocation.message, renderCommandHelp("bs", bsCommand, {prefix: invocation.prefix, title: "保送插件"}), {parseMode: "html"});
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "bs", description: "将回复消息保送至已配置目标",
    async setup(context) { await store(context).update(normalize); },
    renderHelp: prefix => renderCommandHelp("bs", bsCommand, {prefix, title: "保送插件"}),
    commands: {bs: bsCommand}});
}
