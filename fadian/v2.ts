import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext} from "telebox/sdk";

const base = "https://raw.githubusercontent.com/MiCat-S/Mi-Box-Plugins/main/fadian/";
const files: Readonly<Record<string, string>> = {fd: "psycho.json", tg: "tg.json", kfc: "kfc.json", wyy: "wyy.json", cp: "cp.json"};
type Cache = Map<string, {at: number; values: string[]}>;
const TTL = 5 * 60_000;
const MAX_ITEMS = 20_000;
const MAX_ITEM_LENGTH = 4_000;

function escape(value: string): string {
  return value.replace(/[&<>"]/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"})[char]!);
}
const help = (prefix: string) => `<b>发电语录</b>\n<code>${escape(prefix)}fadian fd 名字</code>\n<code>${escape(prefix)}fadian tg</code> · <code>${escape(prefix)}fadian kfc</code> · <code>${escape(prefix)}fadian wyy</code>\n<code>${escape(prefix)}fadian cp 名字1 名字2</code>\n<code>${escape(prefix)}fadian clear</code> 清理缓存`;

async function list(ctx: PluginContext, kind: string, cache: Cache): Promise<string[]> {
  const previous = cache.get(kind);
  if (previous && Date.now() - previous.at < TTL) return previous.values;
  const data = await ctx.http.json<unknown>(base + files[kind], {method: "GET", redirect: "manual", credentials: "omit"}, {timeoutMs: 10_000, signal: ctx.signal, redirects:{allowedHosts:["raw.githubusercontent.com"],maxRedirects:2}});
  if (!Array.isArray(data)) throw new Error("语录数据格式无效");
  const values = data.filter((value): value is string => typeof value === "string" && value.length <= MAX_ITEM_LENGTH).slice(0, MAX_ITEMS);
  if (!values.length) throw new Error("语录数据为空");
  cache.set(kind, {at: Date.now(), values});
  return values;
}

function names(args: readonly string[], reply?: string): string[] {
  const values = args.join(" ").trim().split(/\s+/).filter(Boolean);
  if (values.length) return values;
  return reply?.trim().split(/\s+/).filter(Boolean) ?? [];
}

export default function createFadian() {
  const cache: Cache = new Map();
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "fadian", description: "随机生成发电语录",
    cleanup() {cache.clear();},
    commands: {fadian: {helpOnEmpty: true, helpArgs: ["help","h"], description: "随机生成发电语录", async handle(invocation, ctx) {
      const lines = invocation.message.text.split(/\r?\n/);
      const args = invocation.args;
      const sub = (args[0] ?? "").toLowerCase();
      if (!sub || sub === "help" || sub === "h") {
        await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
        return;
      }
      if (sub === "clear") {
        cache.clear();
        await ctx.telegram.edit(invocation.message, "发电语录缓存已清理");
        return;
      }
      const file = files[sub];
      if (!file) {
        await ctx.telegram.edit(invocation.message, "未知子命令，请使用 fadian help");
        return;
      }
      if (args[1]?.toLowerCase() === "help" || args[1]?.toLowerCase() === "h") {
        await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
        return;
      }
      try {
        let text = "";
          if (sub === "cp") {
          const pair = names(args.slice(1), lines.slice(1, 3).join(" "));
          if (pair.length < 2) throw new Error("CP 语录需要两个人名");
          const values = await list(ctx, sub, cache);
          text = values[Math.floor(Math.random() * values.length)]
            .replaceAll("<name1>", pair[0]).replaceAll("<name2>", pair[1]);
        } else {
          let target = sub === "fd" ? args.slice(1).join(" ").trim() : "";
          if (sub === "fd" && !target) {
            const reply = await ctx.telegram.getReply(invocation.message);
            if (reply) {
              const raw = reply.raw as {sender?: {firstName?: string; lastName?: string; title?: string; username?: string}} | undefined;
              const sender = raw?.sender;
              target = [sender?.firstName, sender?.lastName].filter(Boolean).join(" ").trim() ||
                sender?.title || sender?.username || "Ta";
            }
          }
          if (sub === "fd" && !target) throw new Error("请提供名字或回复一条消息");
          const values = await list(ctx, sub, cache);
          text = values[Math.floor(Math.random() * values.length)].replaceAll("<name>", target);
        }
        await ctx.telegram.edit(invocation.message, escape(text), {parseMode: "html"});
      } catch (error) {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `<b>发电失败</b>\n${escape(error instanceof Error ? error.message : "请稍后重试")}`, {parseMode: "html"});
      }
    }}},
  });
}
