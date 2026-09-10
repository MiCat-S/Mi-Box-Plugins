import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {setTimeout as sleep} from "node:timers/promises";
import {returnBigInt} from "teleproto/Helpers";

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

export default function createPlugin() {
  const list = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const state = await store(context).read();
    const local = state.settings[invocation.message.chatId];
    const all = state.settings["0"];
    await context.telegram.edit(invocation.message, `当前聊天：${local ? `${local} 秒` : all ? `全局 ${all} 秒` : "未设置"}\n全局设置：${all ? `${all} 秒` : "未设置"}`);
  };
  const cancel = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const state = await store(context).read();
    const global = invocation.args.some(value => value.toLowerCase() === "global");
    const key = global ? "0" : invocation.message.chatId;
    if (!state.settings[key]) { await context.telegram.edit(invocation.message, "❌ 未开启自动删除"); return; }
    await store(context).update(value => {
      const settings = {...value.settings};
      delete settings[key];
      return {...value, schemaVersion: 1, settings};
    });
    await context.telegram.edit(invocation.message, "✅ 取消自动删除任务成功。");
  };
  const setDuration = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const action = invocation.args[0]?.toLowerCase();
    if (!action || action === "h" || action === "help") {
      await context.telegram.edit(invocation.message, renderCommandHelp("autodel", autodel, {prefix: invocation.prefix, title: "🕒 定时自动删除消息"}));
      return;
    }
    const global = invocation.args.some(value => value.toLowerCase() === "global");
    const key = global ? "0" : invocation.message.chatId;
    const durationArgs = invocation.args.filter(value => value.toLowerCase() !== "global");
    const seconds = parseDuration(durationArgs);
    if (seconds === undefined) { await context.telegram.edit(invocation.message, "❌ 时间格式错误，请使用如：30s、5 minutes、2小时"); return; }
    if (seconds < 5) { await context.telegram.edit(invocation.message, "❌ 为了安全考虑，自动删除时间不能少于5秒"); return; }
    await store(context).update(value => ({...value, schemaVersion: 1, settings: {...value.settings, [key]: seconds}}));
    await context.telegram.edit(invocation.message, "✅ 设置自动删除任务成功。\n⚠️ 注意：只会删除您自己发送的消息");
  };
  const autodel: CommandDefinition = {
    description: "设置、查看或取消自动删除",
    helpArgs: ["h", "help"],
    helpOnEmpty: true,
    args: "[时间] [global]",
    arguments: [
      {name: "时间", description: "如 30s、5 minutes、2小时；省略时显示帮助"},
      {name: "global", description: "作用于全局设置，而非当前聊天"},
    ],
    examples: [{args: "30s"}, {args: "5 分钟 global"}, {args: "l"}, {args: "cancel global"}],
    help: [
      {heading: "时间格式：", body: "• <code>30 seconds</code>、<code>5 minutes</code>、<code>2 hours</code>、<code>1 days</code>\n• 简写：<code>30s</code>、<code>5m</code>、<code>2h</code>、<code>1d</code>\n• 中文：<code>30秒</code>、<code>5分</code>/<code>5分钟</code>、<code>2小时</code>/<code>2时</code>、<code>1天</code>"},
      {heading: "⚠️ 安全说明：", body: "• 只会删除您自己发送的消息\n• 最小删除时间为5秒"},
    ],
    subcommandsCaseSensitive: false,
    subcommands: {
      l: {aliases: ["list"], description: "查看当前设置", args: "", examples: [{args: "l"}], handle: list},
      cancel: {description: "取消设置", args: "[global]", arguments: [{name: "global", description: "取消全局设置"}], examples: [{args: "cancel"}, {args: "cancel global"}], handle: cancel},
    },
    handle: setDuration,
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "autodel", description: "为自己发出的普通消息设置按聊天或全局自动删除。",
    renderHelp: prefix => renderCommandHelp("autodel", autodel, {prefix, title: "🕒 定时自动删除消息"}),
    commands: {autodel},
    listeners: [{
      edited: false,
      ignoreCommands: true,
      direction: "outgoing",
      async handle(message, context) {
        if (!message.text) return;
        const state = await store(context).read();
        const seconds = state.settings[message.chatId] ?? state.settings["0"];
        if (!seconds) return;
        void scheduleDelete(context, message, seconds).catch(error => {
          if (!context.signal.aborted) context.log.error("autodel:delete", {error: String(error).slice(0, 300)});
        });
      },
    }],
    async setup(context) { await migrate(context); },
  });
}
