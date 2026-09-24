import {
  STRUCTURED_PLUGIN_API_VERSION,
  definePlugin,
  ui,
  type CommandDefinition,
  type CommandInvocation,
  type PluginContext,
  type SubcommandDefinition,
} from "telebox/sdk";

const base = "https://raw.githubusercontent.com/TeleBoxOrg/TeleBox-Plugins/main/fadian/";
const files = { fd: "psycho.json", tg: "tg.json", kfc: "kfc.json", wyy: "wyy.json", cp: "cp.json" } as const;
type Kind = keyof typeof files;
type Cache = Map<Kind, { at: number; values: string[] }>;
const TTL = 300_000;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function rootHelp(prefix: string) {
  const p = esc(prefix);
  return `🗒️ <b>发电语录插件</b>\n\n<b>命令格式：</b>\n<code>${p}fadian [子命令] [参数]</code>\n\n<b>子命令：</b>\n• <code>${p}fadian fd [名字]</code> - 心理语录（回复消息时自动获取对方昵称）\n• <code>${p}fadian tg</code> - TG 语录\n• <code>${p}fadian kfc</code> - KFC 语录\n• <code>${p}fadian wyy</code> - 网抑云语录\n• <code>${p}fadian cp</code> + 第二行/第三行为两个名字\n• <code>${p}fadian clear</code> - 清理缓存并重新下载\n\n<b>使用示例：</b>\n<code>${p}fadian fd 张三</code> - 生成张三的心理语录\n<code>${p}fadian fd</code> (回复消息) - 自动生成被回复人的心理语录\n<code>${p}fadian cp</code>\n第一个人\n第二个人 - 生成CP语录`;
}
function subHelp(prefix: string, sub: string) {
  const p = esc(prefix),
    all: Record<string, string> = {
      fd: `📖 <b>心理语录命令帮助</b>\n\n<code>${p}fadian fd [名字]</code> - 生成心理语录\n\n<b>使用方式：</b>\n1. 直接指定名字：<code>${p}fadian fd 张三</code>\n2. 回复消息后自动获取对方昵称：<code>${p}fadian fd</code>`,
      tg: `📖 <b>TG语录命令帮助</b>\n\n<code>${p}fadian tg</code> - 生成TG舔狗语录`,
      kfc: `📖 <b>KFC语录命令帮助</b>\n\n<code>${p}fadian kfc</code> - 生成KFC疯狂星期四语录`,
      wyy: `📖 <b>网抑云语录命令帮助</b>\n\n<code>${p}fadian wyy</code> - 生成网易云音乐热评语录`,
      cp: `📖 <b>CP语录命令帮助</b>\n\n<code>${p}fadian cp 名字1 名字2</code> - 生成两人CP语录\n或者：\n<code>${p}fadian cp</code>\n第二行写第一个名字\n第三行写第二个名字`,
      clear: `📖 <b>清理缓存命令帮助</b>\n\n<code>${p}fadian clear</code> - 清理本地缓存并重新下载配置文件`,
    };
  return all[sub] ?? rootHelp(prefix);
}
const help = (i: CommandInvocation) => ["help", "h", "--help"].includes(i.args[0]?.toLowerCase() ?? "");
async function list(ctx: PluginContext, kind: Kind, cache: Cache, generation: number, current: () => number) {
  const old = cache.get(kind);
  if (old && Date.now() - old.at < TTL) return old.values;
  const data = await ctx.http.json<unknown>(
    base + files[kind],
    { method: "GET", redirect: "manual", credentials: "omit" },
    {
      timeoutMs: 10_000,
      signal: ctx.signal,
      redirects: { allowedHosts: ["raw.githubusercontent.com"], maxRedirects: 2 },
    },
  );
  if (generation !== current()) throw new Error("STALE_GENERATION");
  if (!Array.isArray(data)) throw new Error("INVALID_DATA");
  const values = data.filter((v): v is string => typeof v === "string" && v.length <= 4000).slice(0, 20_000);
  if (!values.length) throw new Error("EMPTY_DATA");
  cache.set(kind, { at: Date.now(), values });
  return values;
}
function code(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const e = error as { errorMessage?: unknown; message?: unknown };
  return typeof e.errorMessage === "string" ? e.errorMessage : typeof e.message === "string" ? e.message : "";
}
async function fail(i: CommandInvocation, ctx: PluginContext, error: unknown) {
  if (ctx.signal.aborted || code(error) === "STALE_GENERATION") return;
  const value = code(error),
    flood = /FLOOD_WAIT_?(\d+)/.exec(value);
  let text = flood
    ? `⏳ <b>请求过于频繁</b>\n\n需要等待 ${flood[1]} 秒后重试`
    : value.includes("MESSAGE_TOO_LONG")
      ? "❌ <b>消息过长</b>\n\n请减少内容长度或使用文件发送"
      : value === "EMPTY_DATA"
        ? "❌ 数据为空"
        : "❌ <b>插件执行失败:</b> 请稍后重试";
  await ctx.telegram.edit(i.message, text, { parseMode: "html" });
}

export default function createFadian() {
  const cache: Cache = new Map();
  let cacheGeneration = 0;
  const generate = async (
    i: CommandInvocation,
    ctx: PluginContext,
    kind: Kind,
    progress: string,
    names: string[] = [],
  ) => {
    const generation = cacheGeneration;
    try {
      await ctx.telegram.edit(i.message, progress, { parseMode: "html" });
      const values = await list(ctx, kind, cache, generation, () => cacheGeneration);
      if (generation !== cacheGeneration) return;
      let text = values[Math.floor(Math.random() * values.length)]!;
      if (kind === "fd") text = text.replaceAll("<name>", names[0] ?? "");
      if (kind === "cp") text = text.replaceAll("<name1>", names[0] ?? "").replaceAll("<name2>", names[1] ?? "");
      const rendered = await ui.renderRichText(esc(text), ui.PAGE_LABEL_RESERVE + 1),
        raw = rendered.length ? rendered : [esc(text)],
        pages = raw.map((page, index) => page + ui.pageLabel(index, raw.length));
      if (generation !== cacheGeneration) return;
      ctx.signal.throwIfAborted();
      const delivery = await ui.deliverPages(pages, ctx.signal, async (page, index) => {
        if (generation !== cacheGeneration) throw new Error("STALE_GENERATION");
        ctx.signal.throwIfAborted();
        if (index === 0) await ctx.telegram.edit(i.message, page, { parseMode: "html" });
        else await ctx.telegram.reply(i.message, page, { parseMode: "html" });
      });
      if (delivery.interrupted) {
        if (delivery.published === 0) throw delivery.error;
        ctx.log.error("fadian:partial-delivery", { error: ui.deliveryErrorCategory(delivery.error) });
        if (generation !== cacheGeneration) return;
        ctx.signal.throwIfAborted();
        try {
          await ctx.telegram.reply(i.message, ui.interruptedNotice(delivery));
        } catch (noticeError) {
          ctx.log.error("fadian:delivery-notice", { error: ui.deliveryErrorCategory(noticeError) });
        }
      }
    } catch (error) {
      await fail(i, ctx, error);
    }
  };
  const simple = (kind: "tg" | "kfc" | "wyy", description: string, progress: string): SubcommandDefinition => ({
    description,
    async handle(i, ctx) {
      if (help(i)) {
        await ctx.telegram.edit(i.message, subHelp(i.prefix, kind), { parseMode: "html" });
        return;
      }
      await generate(i, ctx, kind, progress);
    },
  });
  const fd: SubcommandDefinition = {
    description: "心理语录（回复消息时自动获取对方昵称）",
    args: "[名字]",
    async handle(i, ctx) {
      if (help(i)) {
        await ctx.telegram.edit(i.message, subHelp(i.prefix, "fd"), { parseMode: "html" });
        return;
      }
      const lines = i.message.text.trim().split(/\r?\n/);
      let name = i.args.join(" ").trim() || (lines[1] ?? "").trim();
      if (!name) {
        const reply = await ctx.telegram.getReply(i.message);
        if (reply) {
          const s = (
            reply.raw as
              { sender?: { firstName?: string; lastName?: string; title?: string; username?: string } } | undefined
          )?.sender;
          name = [s?.firstName, s?.lastName].filter(Boolean).join(" ").trim() || s?.title || s?.username || "Ta";
        }
      }
      if (!name) {
        const p = esc(i.prefix);
        await ctx.telegram.edit(
          i.message,
          `❌ <b>参数不足</b>\n\n💡 使用方法：\n1. <code>${p}fadian fd &lt;名字&gt;</code>\n2. 回复某人消息后使用 <code>${p}fadian fd</code>\n\n示例：<code>${p}fadian fd 张三</code>`,
          { parseMode: "html" },
        );
        return;
      }
      await generate(i, ctx, "fd", "🔄 生成心理语录中...", [name]);
    },
  };
  const cp: SubcommandDefinition = {
    description: "CP 语录（第二行/第三行为两个名字）",
    args: "[名字1 名字2]",
    async handle(i, ctx) {
      if (help(i)) {
        await ctx.telegram.edit(i.message, subHelp(i.prefix, "cp"), { parseMode: "html" });
        return;
      }
      const raw = (i.message.raw as { message?: unknown } | undefined)?.message,
        source = typeof raw === "string" ? raw : i.message.text,
        lines = source.trim().split(/\r?\n/),
        a = (lines[1] || i.args[0] || "").trim(),
        b = (lines[2] || i.args[1] || "").trim();
      if (!a || !b) {
        const p = esc(i.prefix);
        await ctx.telegram.edit(
          i.message,
          `❌ <b>参数不足</b>\n\n💡 使用方法：\n1. <code>${p}fadian cp 名字1 名字2</code>\n2. 或者：<code>${p}fadian cp</code>\n第二行写第一个名字\n第三行写第二个名字`,
          { parseMode: "html" },
        );
        return;
      }
      await generate(i, ctx, "cp", "🔄 生成CP语录中...", [a, b]);
    },
  };
  const clear: SubcommandDefinition = {
    description: "清理缓存并重新下载",
    async handle(i, ctx) {
      if (help(i)) {
        await ctx.telegram.edit(i.message, subHelp(i.prefix, "clear"), { parseMode: "html" });
        return;
      }
      await ctx.telegram.edit(i.message, "🔄 清理缓存中...", { parseMode: "html" });
      cacheGeneration++;
      cache.clear();
      await ctx.telegram.edit(i.message, "🧹 缓存已清理，下次使用时将重新下载配置", { parseMode: "html" });
    },
  };
  const command: CommandDefinition = {
    description: "随机生成发电语录",
    helpOnEmpty: true,
    helpArgs: ["help", "h"],
    subcommandsCaseSensitive: false,
    subcommands: {
      fd,
      tg: simple("tg", "TG 语录", "🔄 生成TG语录中..."),
      kfc: simple("kfc", "KFC 语录", "🔄 生成KFC语录中..."),
      wyy: simple("wyy", "网抑云语录", "🔄 生成网抑云语录中..."),
      cp,
      clear,
    },
    async handle(i, ctx) {
      const sub = i.args[0]?.toLowerCase();
      if (!sub || sub === "help" || sub === "h") {
        await ctx.telegram.edit(i.message, subHelp(i.prefix, i.args[1]?.toLowerCase() ?? ""), { parseMode: "html" });
        return;
      }
      await ctx.telegram.edit(i.message, `❌ <b>未知子命令:</b> <code>${esc(sub)}</code>`, { parseMode: "html" });
    },
  };
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "fadian",
    description: "随机生成发电语录",
    renderHelp: rootHelp,
    cleanup() {
      cache.clear();
    },
    commands: { fadian: command },
  });
}
