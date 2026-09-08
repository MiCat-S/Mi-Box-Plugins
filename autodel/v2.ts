import {setTimeout as sleep} from "node:timers/promises";
import {returnBigInt} from "teleproto/Helpers";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";

type State = {schemaVersion: 1; settings: Record<string, number>; importedLegacy: boolean; [key: string]: unknown};
const defaults: State = {schemaVersion: 1, settings: {}, importedLegacy: false};
const store = (context: PluginContext) => context.storage.json<State>("config.json", defaults);
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function parseDuration(args: readonly string[]): number | undefined {
  const value = args.join("").trim().toLowerCase();
  const match = value.match(/^(\d+)(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|秒|分钟|分|小时|时|天)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = /^(s|sec|secs|second|seconds|秒)$/.test(unit) ? 1
    : /^(m|min|mins|minute|minutes|分|分钟)$/.test(unit) ? 60
      : /^(h|hr|hrs|hour|hours|时|小时)$/.test(unit) ? 3600 : 86400;
  const seconds = amount * multiplier;
  return Number.isSafeInteger(seconds * 1000) ? seconds : undefined;
}

async function migrate(context: PluginContext): Promise<void> {
  const current = await store(context).read();
  if (current.importedLegacy) return;
  let settings = {...current.settings};
  try {
    const legacy = context.storage.sqlite("autodel.db", {readonly: true});
    const rows = await legacy.read(db => db.prepare<[], {chat_id: string; seconds: bigint}>(
      "SELECT chat_id, seconds FROM autodel_settings",
    ).all());
    for (const row of rows) {
      const seconds = Number(row.seconds);
      if (Number.isSafeInteger(seconds) && seconds >= 5) settings[String(row.chat_id)] = seconds;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await store(context).update(value => ({...value, schemaVersion: 1, settings, importedLegacy: true}));
}

function scheduleDelete(context: PluginContext, message: MessageEnvelope, seconds: number): Promise<void> {
  const {chatId, id} = message;
  return context.tasks.run(`autodel:${chatId}:${id}`, async signal => {
    let remaining = seconds * 1000;
    while (remaining > 0) {
      const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
      await sleep(delay, undefined, {signal});
      remaining -= delay;
    }
    signal.throwIfAborted();
    await context.telegram.withClient(async client => {
      await client.deleteMessages(returnBigInt(chatId), [id], {revoke: false});
    });
  });
}

export default function createPlugin() { return definePlugin({
  apiVersion: 1,
  id: "autodel",
  description: "为自己发出的普通消息设置按聊天或全局自动删除。",
  commands: {
    autodel: {
      description: "设置、查看或取消自动删除",
      async handle({message, args, prefix}, context) {
        const action = args[0]?.toLowerCase();
        const state = await store(context).read();
        const global = args.some(value => value.toLowerCase() === "global");
        const key = global ? "0" : message.chatId;
        if (!action || action === "h" || action === "help") {
          await context.telegram.edit(message, `<b>定时删除消息</b>\n<code>${prefix}autodel 30s [global]</code>\n<code>${prefix}autodel l</code>\n<code>${prefix}autodel cancel [global]</code>`, {parseMode: "html"});
          return;
        }
        if (action === "l" || action === "list") {
          const local = state.settings[message.chatId];
          const all = state.settings["0"];
          await context.telegram.edit(message, `当前聊天：${local ? `${local} 秒` : all ? `全局 ${all} 秒` : "未设置"}\n全局设置：${all ? `${all} 秒` : "未设置"}`);
          return;
        }
        if (action === "cancel") {
          if (!state.settings[key]) {
            await context.telegram.edit(message, "❌ 未开启自动删除");
            return;
          }
          await store(context).update(value => {
            const settings = {...value.settings};
            delete settings[key];
            return {...value, schemaVersion: 1, settings};
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
        await store(context).update(value => ({...value, schemaVersion: 1, settings: {...value.settings, [key]: seconds}}));
        await context.telegram.edit(message, "✅ 设置自动删除任务成功。\n⚠️ 注意：只会删除您自己发送的消息");
      },
    },
  },
  listeners: [{
    edited: false,
    ignoreCommands: true,
    async handle(message, context) {
      if (!message.outgoing || !message.text) return;
      const state = await store(context).read();
      const seconds = state.settings[message.chatId] ?? state.settings["0"];
      if (!seconds) return;
      void scheduleDelete(context, message, seconds).catch(error => {
        if (!context.signal.aborted) context.log.error("autodel:delete", {error: String(error).slice(0, 300)});
      });
    },
  }],
  async setup(context) { await migrate(context); },
}); }
