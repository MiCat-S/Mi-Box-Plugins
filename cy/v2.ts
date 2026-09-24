import { collectWords, buildWordItems, renderWordCloud } from "./v2/wordcloud";
import { renderHelp as renderPluginHelp } from "./v2/help";
import { readFile } from "node:fs/promises";
import { definePlugin, type PluginContext } from "telebox/sdk";

type State = {
  schemaVersion: 1;
  enabled: boolean;
  target: string;
  times: string[];
  limit: number;
  lastRunKeys: string[];
  importedLegacy: boolean;
  [key: string]: unknown;
};
const defaults: State = {
  schemaVersion: 1,
  enabled: false,
  target: "",
  times: [],
  limit: 500,
  lastRunKeys: [],
  importedLegacy: false,
};
const store = (c: PluginContext) => c.storage.json<State>("schedule.json", defaults);
const valid = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const limit = (v: unknown, f = 500) => {
  const n = Number(v);
  return !Number.isFinite(n) || n <= 0 ? f : Math.max(50, Math.min(2000, Math.floor(n)));
};
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    x => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[x]!,
  );
function normalize(v: any): State {
  return {
    ...v,
    schemaVersion: 1,
    enabled: v?.enabled === true,
    target: typeof v?.target === "string" ? v.target.trim() : "",
    times: Array.isArray(v?.times) ? [...new Set(v.times.map(String).filter(valid))].slice(0, 12) : [],
    limit: limit(v?.limit),
    lastRunKeys: Array.isArray(v?.lastRunKeys) ? v.lastRunKeys.map(String).slice(-40) : [],
    importedLegacy: true,
  };
}
async function migrate(c: PluginContext) {
  const cur = await store(c).read();
  if (cur.importedLegacy && cur.schemaVersion === 1) return;
  let source: any = cur;
  try {
    source = { ...(JSON.parse(await readFile(c.files.dataPath("cy_schedule.json"), "utf8")) as object), ...cur };
  } catch {}
  await store(c).update(() => normalize(source));
}
async function telegramTarget(value: any, signal: AbortSignal): Promise<any> {
  if (typeof value !== "string" || !/^[-+]?\d+$/.test(value.trim())) return value;
  const { returnBigInt } = await import("teleproto/Helpers.js");
  signal.throwIfAborted();
  return returnBigInt(value.trim());
}

async function generate(c: PluginContext, target: any, count: number, caller: AbortSignal) {
  return c.telegram.withClient(async (client, clientSignal) => {
    const signal = AbortSignal.any([caller, clientSignal]),
      counts = new Map<string, number>();
    let useful = 0;
    signal.throwIfAborted();
    const peer = await telegramTarget(target, signal);
    signal.throwIfAborted();
    for await (const raw of client.iterMessages(peer, { limit: count })) {
      signal.throwIfAborted();
      const text = String(raw?.text || raw?.message || "").trim();
      if (!text || raw?.sticker || c.commands.parse(text)) continue;
      useful++;
      collectWords(text, counts);
    }
    signal.throwIfAborted();
    const items = buildWordItems(counts);
    if (!items.length) throw new Error("insufficient_words");
    const png = renderWordCloud(items, count, useful);
    signal.throwIfAborted();
    return png;
  });
}
async function send(c: PluginContext, target: any, count: number, replyTo: number | undefined, caller: AbortSignal) {
  const png = await generate(c, target, count, caller);
  caller.throwIfAborted();
  if (png.length > 10 * 1024 * 1024) throw new Error("output_too_large");
  await c.telegram.withClient(async (client, clientSignal) => {
    const signal = AbortSignal.any([caller, clientSignal]);
    signal.throwIfAborted();
    const peer = await telegramTarget(target, signal);
    signal.throwIfAborted();
    const { CustomFile } = await import("teleproto/client/uploads.js");
    signal.throwIfAborted();
    await client.sendFile(peer, {
      file: new CustomFile("cy-wordcloud.png", png.length, "", png),
      ...(replyTo !== undefined ? { replyTo } : {}),
    });
    signal.throwIfAborted();
  });
}
function status(s: State) {
  return `词云定时：${s.enabled ? "on" : "off"}\n目标：${s.target || "未设置"}\n时间：${s.times.join(", ") || "未设置"}\n数量：${s.limit}`;
}

export default function createCy() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "cy",
    description: "统计聊天热词并生成词云",
    commands: {
      cy: {
        helpArgs: ["help", "?"],
        description: "立即或定时生成词云",
        ignoreEdited: true,
        async handle({ message, args, prefix }, c) {
          const rawSub = args[0]?.toLowerCase(),
            aliases: Record<string, string> = {
              chat: "target",
              group: "target",
              at: "time",
              enable: "on",
              start: "on",
              disable: "off",
              stop: "off",
            },
            sub = rawSub ? (aliases[rawSub] ?? rawSub) : undefined,
            state = normalize(await store(c).read());
          if (sub === "target") {
            const target = !args[1] || args[1] === "here" ? message.chatId : args[1];
            await store(c).update(v => normalize({ ...v, target }));
            await c.telegram.edit(message, `词云目标已设置：${esc(target)}`);
            return;
          }
          if (sub === "time") {
            const values = args.slice(1).flatMap(x => x.split(",")),
              times = values.filter(valid),
              numeric = values.find(x => /^\d+$/.test(x));
            if (!times.length || values.some(x => !valid(x) && !/^\d+$/.test(x))) {
              await c.telegram.edit(message, `用法：${prefix}cy time 09:00,21:30 [数量]`);
              return;
            }
            const next = await store(c).update(v =>
              normalize({ ...v, times, limit: numeric ? limit(numeric, normalize(v).limit) : normalize(v).limit }),
            );
            await c.telegram.edit(message, status(next));
            return;
          }
          if (sub === "on" || sub === "off") {
            let configured = true;
            const next = await store(c).update(v => {
              const next = normalize({ ...v, enabled: sub === "on" });
              if (next.enabled && (!next.target || !next.times.length)) {
                configured = false;
                return v;
              }
              return next;
            });
            if (!configured) {
              await c.telegram.edit(message, "请先设置目标和时间");
              return;
            }
            await c.telegram.edit(message, status(next));
            return;
          }
          if (sub === "status" || sub === "config") {
            await c.telegram.edit(message, status(state));
            return;
          }
          if (sub === "help" || sub === "?") {
            await c.telegram.edit(
              message,
              `<code>${prefix}cy [数量]</code>\n<code>${prefix}cy target here|目标</code>\n<code>${prefix}cy time 09:00,21:30 [数量]</code>\n<code>${prefix}cy on|off|status</code>`,
              { parseMode: "html" },
            );
            return;
          }
          const directed = sub === "send" || sub === "now",
            count = directed ? limit(args[1], state.limit) : limit(sub, 500),
            target = directed ? state.target || message.chatId : message.chatId;
          await c.telegram.edit(
            message,
            directed ? `正在发送词云到 ${esc(target)}...` : `正在统计最近 ${count} 条消息…`,
          );
          try {
            await send(c, target, count, directed ? undefined : (message.replyToId ?? message.id), c.signal);
          } catch (error) {
            c.signal.throwIfAborted();
            if (error instanceof Error && error.name === "AbortError") throw error;
            await c.telegram.edit(message, "没有统计到足够的热词，或词云生成失败");
            return;
          }
          try {
            await c.telegram.withClient(async (_client, signal) => {
              signal.throwIfAborted();
              const raw = message.raw as any;
              if (typeof raw?.delete === "function") await raw.delete({ revoke: true });
              signal.throwIfAborted();
            });
          } catch (error) {
            c.signal.throwIfAborted();
            if (error instanceof Error && error.name === "AbortError") throw error;
            c.log.error("cy_status_cleanup_failed");
          }
        },
      },
    },
    jobs: {
      scheduled_cloud: {
        description: "发送定时词云",
        cron: "* * * * *",
        timeZone: "Asia/Shanghai",
        async handle(c, signal) {
          const state = normalize(await store(c).read());
          signal.throwIfAborted();
          if (!state.enabled || !state.target || !state.times.length) return;
          const parts = new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Asia/Shanghai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).formatToParts();
          const get = (t: string) => parts.find(x => x.type === t)?.value ?? "",
            time = `${get("hour")}:${get("minute")}`,
            key = `${get("year")}-${get("month")}-${get("day")}:${time}`;
          if (!state.times.includes(time) || state.lastRunKeys.includes(key)) return;
          await send(c, state.target, state.limit, undefined, signal);
          signal.throwIfAborted();
          await store(c).update(
            v => normalize({ ...v, lastRunKeys: [...normalize(v).lastRunKeys, key].slice(-40) }),
            signal,
          );
        },
      },
    },
    settings: c => ({
      id: "cy",
      title: "词云",
      description: "词云定时任务配置",
      category: "插件配置",
      icon: "☁️",
      getSchema: () => [
        { key: "enabled", label: "启用定时", type: "boolean" },
        { key: "target", label: "目标聊天", type: "string" },
        { key: "times", label: "执行时间", type: "json" },
        { key: "limit", label: "消息数量", type: "number", min: 50, max: 2000 },
      ],
      getValues: () => store(c).read(),
      setValues: async patch => {
        await store(c).update(v => normalize({ ...v, ...patch }));
      },
    }),
    setup: migrate,
  });
}
