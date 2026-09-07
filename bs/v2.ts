import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

type Target = {id: string; target: string; chatId?: string; topicId?: string; display?: string; status?: "0"; createdAt: string; updatedAt?: string; [key: string]: unknown};
type State = {schemaVersion: number; seq: string; mode: "sequence" | "broadcast"; targets: Target[]; [key: string]: unknown};
const defaults = (): State => ({schemaVersion: 1, seq: "0", mode: "sequence", targets: []});
const store = (context: PluginContext) => context.storage.json<State>("config.json", defaults());
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function normalize(source: State): State {
  const targets = Array.isArray(source.targets) ? source.targets.filter(value => value && typeof value.target === "string").map(value => ({
    ...value, id: String(value.id), target: String(value.target), chatId: value.chatId === undefined ? undefined : String(value.chatId),
    topicId: value.topicId === undefined ? undefined : String(value.topicId), createdAt: String(value.createdAt ?? Date.now()),
  })) : [];
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

function help(prefix: string): string {
  return `<b>保送插件</b>\n<code>${prefix}bs [数量]</code> 回复消息后转发\n` +
    `<code>${prefix}bs add 目标[|话题ID]</code>\n<code>${prefix}bs list</code>\n` +
    `<code>${prefix}bs del ID</code> · <code>${prefix}bs enable ID</code> · <code>${prefix}bs disable ID</code>\n` +
    `<code>${prefix}bs toggle mode</code>`;
}

function forwarded(result: any): any[] {
  return Array.isArray(result?.updates) ? result.updates.map((value: any) => value?.message).filter((value: any) => value?.className === "Message") : [];
}

async function forward(invocation: any, context: PluginContext, count: number): Promise<void> {
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
  return definePlugin({apiVersion: 1, id: "bs", description: "将回复消息保送至已配置目标",
    async setup(context) { await store(context).update(normalize); },
    commands: {bs: {description: "管理目标或保送回复消息", async handle(invocation: any, context: PluginContext) {
      const command = (invocation.args[0] ?? "").toLowerCase();
      if (!command || /^\d+$/.test(command)) return forward(invocation, context, command ? Number(command) : 1);
      if (["help", "h", "说明"].includes(command)) { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
      if (["list", "ls"].includes(command)) { await context.telegram.edit(invocation.message, list(normalize(await store(context).read())), {parseMode: "html", linkPreview: false}); return; }
      if (command === "add") {
        const rawTarget = invocation.args.slice(1).join(" ").trim();
        const [target, topicId] = rawTarget.split(/\s*[|｜]\s*/, 2);
        if (!target) { await context.telegram.edit(invocation.message, "请提供目标对话"); return; }
        try {
          let resolved: any;
          await context.telegram.withClient(async client => { resolved = await client.getEntity(/^-?\d+$/.test(target) ? BigInt(target) : target); });
          const state = await store(context).update(source => {
            const value = normalize(source); const id = String(Number(value.seq) + 1); value.seq = id;
            value.targets.push({id, target, chatId: resolved?.id?.toString(), topicId: /^\d+$/.test(topicId ?? "") ? topicId : undefined,
              display: resolved?.title || [resolved?.firstName, resolved?.lastName].filter(Boolean).join(" ") || resolved?.username && `@${resolved.username}` || target,
              createdAt: String(Date.now())}); return value;
          });
          await context.telegram.edit(invocation.message, `目标 <code>${state.seq}</code> 已添加`, {parseMode: "html"});
        } catch { await context.telegram.edit(invocation.message, "无法解析目标对话"); }
        return;
      }
      if (command === "toggle" && invocation.args[1]?.toLowerCase() === "mode") {
        const state = await store(context).update(source => { const value = normalize(source); value.mode = value.mode === "sequence" ? "broadcast" : "sequence"; return value; });
        await context.telegram.edit(invocation.message, `模式已切换为${state.mode === "broadcast" ? "群发" : "顺序"}`); return;
      }
      const id = invocation.args[1];
      const actions: Record<string, "remove" | "on" | "off"> = {rm: "remove", del: "remove", enable: "on", on: "on", disable: "off", off: "off"};
      if (actions[command] && id) {
        let found = false;
        await store(context).update(source => { const state = normalize(source); const target = state.targets.find(value => value.id === id);
          if (!target) return state; found = true;
          if (actions[command] === "remove") state.targets = state.targets.filter(value => value.id !== id);
          else if (actions[command] === "off") target.status = "0"; else delete target.status;
          return state; });
        await context.telegram.edit(invocation.message, found ? "目标状态已更新" : "目标不存在"); return;
      }
      await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
    }}},
  });
}
