import { renderHelp as renderPluginHelp } from "./v2/help";
import { setTimeout as sleep } from "node:timers/promises";
import { returnBigInt } from "teleproto/Helpers";
import { definePlugin, type PluginContext } from "telebox/sdk";

type State = { schemaVersion: 1; settings: Record<string, number>; importedLegacy: boolean; [key: string]: unknown };
const defaults: State = { schemaVersion: 1, settings: {}, importedLegacy: false };
const store = (context: PluginContext) => context.storage.json<State>("config.json", defaults);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// The original read `msg.peerId.toString()`, which is literally this string for every chat,
// so its "chat" scope was really a second global scope that outranked the "0" global row.
const LEGACY_SHARED_KEY = "[object Object]";

function parseDuration(args: readonly string[]): number | undefined {
  const value = args.join("").trim().toLowerCase();
  const match = value.match(/^(\d+)(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|秒|分钟|分|小时|时|天)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = /^(s|sec|secs|second|seconds|秒)$/.test(unit)
    ? 1
    : /^(m|min|mins|minute|minutes|分|分钟)$/.test(unit)
      ? 60
      : /^(h|hr|hrs|hour|hours|时|小时)$/.test(unit)
        ? 3600
        : 86400;
  const seconds = amount * multiplier;
  return Number.isSafeInteger(seconds * 1000) ? seconds : undefined;
}

async function migrate(context: PluginContext): Promise<void> {
  const current = await store(context).read();
  if (current.importedLegacy) return;
  const imported: Record<string, number> = {};
  try {
    const legacy = context.storage.sqlite("autodel.db", { readonly: true });
    const rows = await legacy.read(db =>
      db.prepare<[], { chat_id: string; seconds: bigint }>("SELECT chat_id, seconds FROM autodel_settings").all(),
    );
    let shared: number | undefined;
    let global: number | undefined;
    for (const row of rows) {
      const seconds = Number(row.seconds);
      if (!Number.isSafeInteger(seconds) || seconds < 5 || !Number.isSafeInteger(seconds * 1000)) continue;
      const key = String(row.chat_id);
      if (key === LEGACY_SHARED_KEY) shared = seconds;
      else if (key === "0") global = seconds;
      else imported[key] = seconds;
    }
    // The shared original scope applied to every chat and outranked the "0" row; map it onto
    // the V2 global key so the effective legacy behaviour survives the one-time import.
    const effectiveGlobal = shared ?? global;
    if (effectiveGlobal !== undefined) imported["0"] = effectiveGlobal;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await store(context).update(value => ({
    ...value,
    schemaVersion: 1,
    // Existing V2 settings are newer than the one-time legacy import.
    settings: { ...imported, ...value.settings },
    importedLegacy: true,
  }));
}

function scheduleDelete(context: PluginContext, chatId: string, id: number, seconds: number): Promise<void> {
  return context.tasks.run(`autodel:${chatId}:${id}`, async signal => {
    let remaining = seconds * 1000;
    while (remaining > 0) {
      const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
      await sleep(delay, undefined, { signal });
      remaining -= delay;
    }
    signal.throwIfAborted();
    await context.telegram.withClient(async client => {
      await client.deleteMessages(returnBigInt(chatId), [id], { revoke: false });
    });
  });
}

export default function createPlugin() {
  // Per-instance cache of the authenticated decimal account id. A failed or cancelled
  // lookup is never cached, so a later message can retry; without an id we schedule nothing.
  let selfId: string | undefined;
  const resolveSelfId = async (context: PluginContext): Promise<string | undefined> => {
    if (selfId) return selfId;
    try {
      const user = await context.telegram.withClient(client => client.getMe());
      const raw = (user as { id?: unknown }).id;
      if (typeof raw === "number" && !Number.isSafeInteger(raw)) return undefined;
      const text = raw === undefined || raw === null ? "" : String(raw);
      if (!/^[1-9][0-9]*$/.test(text)) return undefined;
      selfId = text;
      return text;
    } catch {
      return undefined;
    }
  };
  const definition = definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "autodel",
    description: "为自己发出的普通消息设置按聊天或全局自动删除。",
    commands: {
      autodel: {
        helpArgs: ["h", "help"],
        helpOnEmpty: true,
        description: "设置、查看或取消自动删除",
        async handle({ message, args, prefix }, context) {
          const action = args[0]?.toLowerCase();
          const state = await store(context).read();
          const global = args.some(value => value.toLowerCase() === "global");
          const key = global ? "0" : message.chatId;
          if (!action || action === "h" || action === "help") {
            await context.telegram.edit(
              message,
              `<b>定时删除消息</b>\n<code>${prefix}autodel 30s [global]</code>\n<code>${prefix}autodel l</code>\n<code>${prefix}autodel cancel [global]</code>`,
              { parseMode: "html" },
            );
            return;
          }
          if (action === "l" || action === "list") {
            const local = state.settings[message.chatId];
            const all = state.settings["0"];
            await context.telegram.edit(
              message,
              `📋 <b>自动删除设置：</b>\n\n当前聊天：${local ? `${local} 秒` : all ? `全局 ${all} 秒` : "未设置"}\n全局设置：${all ? `${all} 秒` : "未设置"}`,
              { parseMode: "html" },
            );
            return;
          }
          if (action === "cancel") {
            if (!state.settings[key]) {
              await context.telegram.edit(message, "❌ 未开启自动删除");
              return;
            }
            await store(context).update(value => {
              const settings = { ...value.settings };
              delete settings[key];
              return { ...value, schemaVersion: 1, settings };
            });
            await context.telegram.edit(message, "✅ 取消自动删除任务成功。");
            return;
          }
          const durationArgs = args.filter(value => value.toLowerCase() !== "global");
          const seconds = parseDuration(durationArgs);
          if (seconds === undefined) {
            await context.telegram.edit(message, "❌ 时间格式错误，请使用如：30s、5 minutes、2小时");
            return;
          }
          if (seconds < 5) {
            await context.telegram.edit(message, "❌ 为了安全考虑，自动删除时间不能少于5秒");
            return;
          }
          await store(context).update(value => ({
            ...value,
            schemaVersion: 1,
            settings: { ...value.settings, [key]: seconds },
          }));
          await context.telegram.edit(message, "✅ 设置自动删除任务成功。\n⚠️ 注意：只会删除您自己发送的消息");
        },
      },
    },
    listeners: [
      {
        edited: false,
        ignoreCommands: true,
        async handle(message, context) {
          if (!message.outgoing || !message.text) return;
          const state = await store(context).read();
          const seconds = state.settings[message.chatId] ?? state.settings["0"];
          if (!seconds) return; // no deletion setting: never pay for an account lookup
          // The original resolved the account with getMe and deleted only messages it authored.
          const me = await resolveSelfId(context);
          if (!me || message.senderId !== me) return;
          // Keep only primitives: the pending promise's rejection handler must not retain the
          // native message payload (message.raw) for the whole deletion deadline.
          const { chatId, id } = message;
          void scheduleDelete(context, chatId, id, seconds).catch(() => {
            // Fixed event and non-sensitive ids only; the underlying error may echo credentials.
            if (!context.signal.aborted) context.log.error("autodel:delete_failed", { chatId, messageId: id });
          });
        },
      },
    ],
    async setup(context) {
      await migrate(context);
    },
  });
  return definition;
}
