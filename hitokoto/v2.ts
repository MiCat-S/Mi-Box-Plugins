import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, ui, type CommandInvocation, type PluginContext} from "telebox/sdk";
import {setTimeout as delay} from "node:timers/promises";

type Hitokoto = {hitokoto: unknown; type?: unknown; from?: unknown; from_who?: unknown};
const types: Readonly<Record<string, string>> = {
  a: "动画", b: "漫画", c: "游戏", d: "文学", e: "原创", f: "网络",
  g: "其他", h: "影视", i: "诗词", j: "网易云", k: "哲学", l: "抖机灵",
};

function escape(value: string): string {
  return value.replace(/[&<>\"]/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"})[char]!);
}

function parseTypes(args: readonly string[]): string[] | undefined {
  const selected = args.map(value => value.toLowerCase()).filter(value => Object.hasOwn(types, value));
  return selected.length ? selected : undefined;
}

function resultText(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("接口返回格式无效");
  const value = data as Hitokoto;
  if (typeof value.hitokoto !== "string" || !value.hitokoto.trim() || value.hitokoto.length > 2000) {
    throw new Error("接口返回内容无效");
  }
  const source = typeof value.from === "string" && value.from ? `《${escape(value.from.slice(0, 200))}》` : "";
  const kind = typeof value.type === "string" && types[value.type] ? `（${types[value.type]}）` : "";
  const author = typeof value.from_who === "string" && value.from_who ? ` - ${escape(value.from_who.slice(0, 100))}` : "";
  const detail = source || kind || author ? `\n\n📚 ${source}${kind}${author}` : "";
  return `💬 ${escape(value.hitokoto)}${detail}`;
}

async function fetchHitokoto(ctx: PluginContext, selected: string[] | undefined): Promise<string> {
  const url = new URL("https://v1.hitokoto.cn/");
  url.searchParams.set("charset", "utf-8");
  if (selected?.length === 1) url.searchParams.set("c", selected[0]);
  if (selected && selected.length > 1) for (const type of selected) url.searchParams.append("c", type);
  let last: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    ctx.signal.throwIfAborted();
    let data: unknown;
    try {
      data = await ctx.http.json<unknown>(url, {
        method: "GET", redirect: "manual", credentials: "omit",
        headers: {"Accept": "application/json", "User-Agent": "Mi-Box-Hitokoto/1.0"},
      }, {timeoutMs: 10_000, signal: ctx.signal, redirects:{allowedHosts:["v1.hitokoto.cn"],maxRedirects:2}});
    } catch (error) {
      last = error;
      ctx.signal.throwIfAborted();
      if (attempt < 9) await delay(1000, undefined, {signal: ctx.signal});
      continue;
    }
    return resultText(data);
  }
  throw last instanceof Error ? last : new Error("请求失败");
}

async function deliverResult(invocation: CommandInvocation, ctx: PluginContext, html: string): Promise<void> {
  const pages = await ui.renderRichText(html, ui.PAGE_LABEL_RESERVE);
  const delivery = await ui.deliverPages(pages, ctx.signal, (page, index) => {
    const labelled = page + ui.pageLabel(index, pages.length);
    return index === 0
      ? ctx.telegram.edit(invocation.message, labelled, {parseMode: "html"})
      : ctx.telegram.reply(invocation.message, labelled, {parseMode: "html"});
  });
  if (!delivery.interrupted) return;
  ctx.log.error("hitokoto_delivery_failed", {
    kind: ui.deliveryErrorCategory(delivery.error), published: delivery.published, total: delivery.total,
  });
  if (delivery.published === 0) throw new Error("hitokoto delivery failed");
  try {
    await ctx.telegram.reply(invocation.message, ui.interruptedNotice(delivery));
  } catch (error) {
    ctx.signal.throwIfAborted();
    ctx.log.error("hitokoto_delivery_notice_failed", {kind: ui.deliveryErrorCategory(error)});
  }
}

export default function createHitokoto() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "hitokoto", description: "获取随机一言并按类型筛选",
    commands: {hitokoto: {helpArgs: ["help","h"], description: "获取随机一言", async handle(invocation, ctx) {
      const args = invocation.args.map(value => value.trim()).filter(Boolean);
      if (args[0]?.toLowerCase() === "help" || args[0]?.toLowerCase() === "h") {
        await ctx.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), {parseMode: "html"});
        return;
      }
      try {
        const selected = parseTypes(args);
        await ctx.telegram.edit(invocation.message, "正在获取一言…");
        await deliverResult(invocation, ctx, await fetchHitokoto(ctx, selected));
      } catch (error) {
        ctx.signal.throwIfAborted();
        await ctx.telegram.edit(invocation.message, "<b>一言失败</b>\n获取一言失败，请稍后重试", {parseMode: "html"});
      }
    }}},
  });
}
