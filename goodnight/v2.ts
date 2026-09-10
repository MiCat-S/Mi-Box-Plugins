import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type PluginContext} from "telebox/sdk";

type Group = {
  enabled: boolean; timezone?: number; date: string;
  sleepUsers?: string[]; wakeUsers?: string[];
  sleep?: string[]; wake?: string[];
};
type CurrentGroup = Group & {timezone: number; sleepUsers: string[]; wakeUsers: string[]};
type Data = {groups: Record<string, Group>};
const clock = (zone: number) => new Date(Date.now() + zone * 3600000).toISOString().slice(0, 19).replace("T", " ");
const store = (ctx: PluginContext) => ctx.storage.json<Data>("data.json", {groups: {}});
function normalize(source?: Group, zone = source?.timezone ?? 8): CurrentGroup {
  const date = clock(zone).slice(0, 10);
  const sameDay = source?.date === date;
  const {sleep, wake, ...rest} = source ?? {};
  return {...rest, enabled: source?.enabled ?? false, timezone: zone, date,
    sleepUsers: sameDay ? [...(source?.sleepUsers ?? sleep ?? [])] : [],
    wakeUsers: sameDay ? [...(source?.wakeUsers ?? wake ?? [])] : []};
}
const sleepWords = new Set(["晚安", "晚", "睡觉", "睡了", "去睡了", "晚安喵"]);
const wakeWords = new Set(["早", "早上好", "早安", "起床", "早安喵"]);

export default function createGoodnight() {
  const configure = async (invocation: CommandInvocation, ctx: PluginContext, arg?: string) => {
    const match = arg?.match(/^(?:utc|gmt)?([+-]?\d{1,2})$/i);
    const zone = match ? Number(match[1]) : undefined;
    const db = store(ctx);
    let current: CurrentGroup | undefined;
    await db.update(data => {
      current = normalize(data.groups[invocation.message.chatId], zone);
      if (arg === "on" || arg === "off") current.enabled = arg === "on";
      return {...data, groups: {...data.groups, [invocation.message.chatId]: current}};
    });
    const g = current!;
    if (arg === "on" || arg === "off") {
      await ctx.telegram.edit(invocation.message, g.enabled ? "早晚安统计已开启" : "早晚安统计已关闭"); return;
    }
    const timezone = `UTC${g.timezone >= 0 ? "+" : ""}${g.timezone}`;
    if (zone !== undefined) {
      await ctx.telegram.edit(invocation.message, `时区已设置为 ${timezone}\n当前时间: ${clock(g.timezone)}`); return;
    }
    await ctx.telegram.edit(invocation.message,
      `<b>早晚安统计</b>\n状态: ${g.enabled ? "开启" : "关闭"}\n时区: ${timezone}\n当前时间: ${clock(g.timezone)}\n日期: ${g.date}\n晚安: ${g.sleepUsers.length} 人\n早安: ${g.wakeUsers.length} 人`,
      {parseMode: "html"});
  };
  const goodnightCommand: CommandDefinition = {
    description: "早晚安统计设置",
    helpArgs: ["help", "h"],
    args: "[on|off|utc+N]",
    arguments: [{name: "on/off", description: "开启或关闭统计"}, {name: "utc+8", description: "设置时区，范围 -12 至 +14，默认 +8；支持 utc+8、utc-5、gmt+8 或数字"}, {name: "无参数", description: "查看当前状态"}],
    examples: [{args: ""}, {args: "on"}, {args: "off"}, {args: "utc+8"}],
    subcommandsCaseSensitive: false,
    subcommands: {
      on: {description: "开启早晚安统计", args: "", examples: [{args: "on"}], async handle(invocation, ctx) { await configure(invocation, ctx, "on"); }},
      off: {description: "关闭早晚安统计", args: "", examples: [{args: "off"}], async handle(invocation, ctx) { await configure(invocation, ctx, "off"); }},
    },
    help: [
      {heading: "说明：", body: "自动回复早晚安并统计排名，默认关闭，需手动开启。支持 utc+8 / utc-5 等时区格式；<code>{prefix}gn</code> 是 <code>{prefix}goodnight</code> 的别名，参数相同。"},
    ],
    async handle(invocation, ctx) {
      const arg = invocation.args[0]?.toLowerCase();
      if (arg === "help" || arg === "h") { await ctx.telegram.edit(invocation.message, renderCommandHelp("goodnight", goodnightCommand, {prefix: invocation.prefix, title: "🌙 早晚安统计插件"}), {parseMode: "html"}); return; }
      const match = arg?.match(/^(?:utc|gmt)?([+-]?\d{1,2})$/i);
      const zone = match ? Number(match[1]) : undefined;
      if (arg && arg !== "on" && arg !== "off" && (zone === undefined || zone < -12 || zone > 14)) {
        await ctx.telegram.edit(invocation.message, renderCommandHelp("goodnight", goodnightCommand, {prefix: invocation.prefix, title: "🌙 早晚安统计插件"}), {parseMode: "html"}); return;
      }
      await configure(invocation, ctx, arg);
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "goodnight", description: "早晚安统计",
    renderHelp: prefix => renderCommandHelp("goodnight", goodnightCommand, {prefix, title: "🌙 早晚安统计插件"}),
    commands: {
      goodnight: goodnightCommand,
      gn: goodnightCommand,
    },
    listeners: [{
      handle: async (message, ctx) => {
        const text = message.text.trim();
        const senderId = message.senderId;
        if (!senderId || !message.chatId || text.length > 10) return;
        const kind = sleepWords.has(text) ? "sleepUsers" : wakeWords.has(text) ? "wakeUsers" : undefined;
        if (!kind) return;
        const db = store(ctx);
        if (!(await db.read()).groups[message.chatId]?.enabled) return;
        let rank = 0;
        let time = "";
        await db.update(data => {
          const source = data.groups[message.chatId];
          if (!source?.enabled) return data;
          const g = normalize(source);
          const index = g[kind].indexOf(senderId);
          if (index < 0) g[kind].push(senderId);
          rank = index < 0 ? g[kind].length : index + 1;
          time = clock(g.timezone);
          return {...data, groups: {...data.groups, [message.chatId]: g}};
        });
        if (!rank) return;
        ctx.signal.throwIfAborted();
        type Sender = {firstName?: string; username?: string};
        const raw = message.raw as {sender?: Sender; getSender?: () => Promise<Sender | undefined>} | undefined;
        let sender = raw?.sender;
        if (!sender && raw?.getSender) {
          try {
            sender = await ctx.telegram.withClient(async (_client, signal) => {
              signal.throwIfAborted();
              return raw.getSender!();
            });
          } catch {
            ctx.signal.throwIfAborted();
            ctx.log.error("goodnight.sender_lookup_failed");
          }
        }
        ctx.signal.throwIfAborted();
        const name = (sender?.firstName || sender?.username || "群友").slice(0, 128);
        const sleeping = kind === "sleepUsers";
        await ctx.telegram.reply(message,
          `${sleeping ? "快睡觉喵" : "起床喵"}！ ${name}!\n现在是 ${time}, 你是本群今天第 ${rank} 个${sleeping ? "睡觉" : "起床"}的。`,
          {linkPreview: false});
      },
    }],
  });
}
