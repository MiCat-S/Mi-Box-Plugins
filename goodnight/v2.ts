import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, ui, type CommandInvocation, type PluginContext } from "telebox/sdk";

type Group = {
  enabled: boolean;
  timezone?: number;
  date: string;
  sleepUsers?: string[];
  wakeUsers?: string[];
  sleep?: string[];
  wake?: string[];
};
type CurrentGroup = Group & { timezone: number; sleepUsers: string[]; wakeUsers: string[] };
type Data = { groups: Record<string, Group> };
const clock = (zone: number) => new Date(Date.now() + zone * 3600000).toISOString().slice(0, 19).replace("T", " ");
const store = (ctx: PluginContext) => ctx.storage.json<Data>("data.json", { groups: {} });
function stored(source?: Group): CurrentGroup {
  const zone = source?.timezone ?? 8;
  const { sleep, wake, ...rest } = source ?? {};
  return {
    ...rest,
    enabled: source?.enabled ?? false,
    timezone: zone,
    date: source?.date ?? clock(zone).slice(0, 10),
    sleepUsers: [...(source?.sleepUsers ?? sleep ?? [])],
    wakeUsers: [...(source?.wakeUsers ?? wake ?? [])],
  };
}
function normalize(source?: Group): CurrentGroup {
  const zone = source?.timezone ?? 8;
  const date = clock(zone).slice(0, 10);
  const sameDay = source?.date === date;
  const { sleep, wake, ...rest } = source ?? {};
  return {
    ...rest,
    enabled: source?.enabled ?? false,
    timezone: zone,
    date,
    sleepUsers: sameDay ? [...(source?.sleepUsers ?? sleep ?? [])] : [],
    wakeUsers: sameDay ? [...(source?.wakeUsers ?? wake ?? [])] : [],
  };
}
const sleepWords = new Set(["晚安", "晚", "睡觉", "睡了", "去睡了", "晚安喵"]);
const wakeWords = new Set(["早", "早上好", "早安", "起床", "早安喵"]);

export default function createGoodnight() {
  const handle = async (invocation: CommandInvocation, ctx: PluginContext) => {
    const arg = invocation.args[0]?.toLowerCase();
    if (arg === "help" || arg === "h") {
      await ctx.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), { parseMode: "html" });
      return;
    }
    const cleaned = arg?.replace(/^(utc|gmt)/i, "");
    const parsed = cleaned === undefined ? NaN : Number.parseInt(cleaned, 10);
    const zone = Number.isNaN(parsed) ? undefined : parsed;
    if (zone !== undefined && (zone < -12 || zone > 14)) {
      await ctx.telegram.edit(invocation.message, "❌ 时区必须在 UTC-12 到 UTC+14 之间", { parseMode: "html" });
      return;
    }
    const db = store(ctx);
    let g = stored((await db.read()).groups[invocation.message.chatId]);
    if (arg === "on" || arg === "off") {
      const enabled = arg === "on";
      if (g.enabled === enabled) {
        await ctx.telegram.edit(
          invocation.message,
          enabled ? "✅ 本群早晚安统计已经是<b>开启</b>状态" : "🚫 本群早晚安统计已经是<b>关闭</b>状态",
          { parseMode: "html" },
        );
        return;
      }
      await db.update(data => {
        g = { ...stored(data.groups[invocation.message.chatId]), enabled };
        return { ...data, groups: { ...data.groups, [invocation.message.chatId]: g } };
      });
      await ctx.telegram.edit(
        invocation.message,
        enabled ? "✅ 本群早晚安统计已<b>开启</b>" : "🚫 本群早晚安统计已<b>关闭</b>",
        { parseMode: "html" },
      );
      return;
    }
    if (zone !== undefined) {
      await db.update(data => {
        g = { ...stored(data.groups[invocation.message.chatId]), timezone: zone };
        return { ...data, groups: { ...data.groups, [invocation.message.chatId]: g } };
      });
      await ctx.telegram.edit(
        invocation.message,
        `✅ 已将本群时区设置为 <b>UTC${zone >= 0 ? "+" : ""}${zone}</b>\n当前时间: ${clock(zone).slice(11)}`,
        { parseMode: "html" },
      );
      return;
    }
    const timezone = `UTC${g.timezone >= 0 ? "+" : ""}${g.timezone}`;
    const prefix = ui.text(invocation.prefix);
    await ctx.telegram.edit(
      invocation.message,
      `🌙 <b>早晚安统计插件</b>\n\n当前状态: ${g.enabled ? "✅ 开启" : "🚫 关闭"}\n当前时区: ${timezone}\n当前时间: ${clock(g.timezone)}\n\n<b>指令:</b>\n• <code>${prefix}goodnight on/off</code> - 开启或关闭统计\n• <code>${prefix}goodnight utc+8</code> - 设置时区\n• <code>${prefix}goodnight</code> - 查看状态`,
      { parseMode: "html" },
    );
  };
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "goodnight",
    description: "早晚安统计",
    listeners: [
      {
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
            return { ...data, groups: { ...data.groups, [message.chatId]: g } };
          });
          if (!rank) return;
          if (ctx.signal.aborted) return;
          type Sender = { firstName?: string; username?: string };
          const raw = message.raw as { sender?: Sender; getSender?: () => Promise<Sender | undefined> } | undefined;
          let sender = raw?.sender;
          if (!sender && raw?.getSender) {
            try {
              sender = await ctx.telegram.withClient(async (_client, signal) => {
                signal.throwIfAborted();
                return raw.getSender!();
              });
            } catch {
              if (ctx.signal.aborted) return;
              ctx.log.error("goodnight.sender_lookup_failed");
            }
          }
          if (ctx.signal.aborted) return;
          const name = Array.from(sender?.firstName || sender?.username || "群友")
            .slice(0, 128)
            .join("");
          const sleeping = kind === "sleepUsers";
          try {
            await ctx.telegram.reply(
              message,
              `${sleeping ? "快睡觉喵" : "起床喵"}！ ${name}!\n现在是 ${time}, 你是本群今天第 ${rank} 个${sleeping ? "睡觉" : "起床"}的。`,
              { linkPreview: false },
            );
          } catch {
            if (!ctx.signal.aborted) ctx.log.error("goodnight.reply_failed");
          }
        },
      },
    ],
    commands: {
      goodnight: { helpArgs: ["help", "h"], description: "早晚安统计设置", handle },
      gn: { helpArgs: ["help", "h"], description: "早晚安统计设置", handle },
    },
  });
}
