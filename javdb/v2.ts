import {load} from "cheerio";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api} from "teleproto";

type Item = {code: string; link: URL; title: string; thumb?: URL; score: string};
const HEADERS = {Accept: "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9", "User-Agent": "MiBot-JavDB/2.0"};

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);
const short = (value: unknown, length: number): string => String(value ?? "").slice(0, length);

function safeUrl(value: string, base: string, hosts: readonly string[]): URL | undefined {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.username || url.password || !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return;
    return url;
  } catch { return; }
}

async function page(context: PluginContext, url: URL): Promise<string> {
  return context.http.text(url, {method: "GET", redirect: "follow", credentials: "omit", headers: HEADERS},
    {timeoutMs: 15_000, signal: context.signal});
}

async function search(context: PluginContext, code: string): Promise<Item[]> {
  const url = new URL("https://javdb.com/search");
  url.searchParams.set("q", code); url.searchParams.set("f", "all");
  const $ = load(await page(context, url));
  return $(".movie-list .item").toArray().flatMap(element => {
    const anchor = $(element).find("a").first();
    const title = anchor.find(".video-title").text().trim();
    const link = safeUrl(anchor.attr("href") ?? "", url.href, ["javdb.com"]);
    if (!title || !link) return [];
    const rawThumb = anchor.find(".cover img").attr("src") ?? "";
    return [{code: (title.match(/([A-Za-z]+-\d+)/)?.[1] ?? "").toUpperCase(), link, title,
      thumb: safeUrl(rawThumb, url.href, ["javdb.com", "jdbstatic.com", "javdb521.com"]),
      score: anchor.find(".score .value").text().trim()}];
  }).slice(0, 20);
}

async function detail(context: PluginContext, url: URL) {
  const $ = load(await page(context, url));
  const value = (label: string, linkOnly = false) => {
    const node = $(`.panel-block strong:contains("${label}")`).first().parent().find(linkOnly ? ".value a" : ".value").first();
    return node.text().trim();
  };
  const list = (label: string) => $(`.panel-block strong:contains("${label}")`).first().parent().find(".value a")
    .toArray().map(node => $(node).text().trim()).filter(Boolean);
  return {director: value("導演", true), series: value("系列", true), date: value("日期"), duration: value("時長"),
    actors: list("演員").slice(0, 20), tags: list("類別").slice(0, 30), score: $(".score .value").first().text().trim()};
}

function rating(value: string): string {
  const parsed = Number(value.match(/\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(parsed)) return "暂无评分";
  const score = Math.max(0, Math.min(5, parsed));
  const full = Math.floor(score);
  const half = score - full >= 0.5 ? 1 : 0;
  return `${"★".repeat(full)}${half ? "✩" : ""}${"☆".repeat(5 - full - half)} ${score.toFixed(2)}分`;
}

async function image(context: PluginContext, url: URL, referer: string): Promise<Buffer> {
  return context.http.withResponse(url, {method: "GET", redirect: "follow", credentials: "omit",
    headers: {Accept: "image/*", Referer: referer, "User-Agent": HEADERS["User-Agent"]}}, async (response, signal) => {
    if (response.status !== 200 || !response.body || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) throw new Error("Invalid image");
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
        total += part.value.byteLength; if (total > 10 * 1024 * 1024) throw new Error("Image too large"); parts.push(part.value);
      }
      return Buffer.concat(parts, total);
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }, {timeoutMs: 20_000, signal: context.signal});
}

export default function createJavdb() {
  const command = {description: "查询 JavDB 番号资料", async handle(invocation: any, context: PluginContext) {
    const raw = invocation.args.join(" ").trim();
    if (!raw || /^(h|help)$/i.test(raw)) {
      await context.telegram.edit(invocation.message,
        `<b>JavDB 番号查询</b>\n<code>${invocation.prefix}javdb ABP-123</code>\n空格会自动转换为连字符。`, {parseMode: "html"}); return;
    }
    const code = raw.replace(/\s+/g, "-").toUpperCase();
    if (!/^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/.test(code)) { await context.telegram.edit(invocation.message, "番号格式无效"); return; }
    await context.telegram.edit(invocation.message, "正在查询番号…");
    try {
      const items = await search(context, code);
      const item = items.find(value => value.code === code) ?? items[0];
      if (!item) { await context.telegram.edit(invocation.message, "未找到相关番号"); return; }
      const info = await detail(context, item.link);
      const fields = [info.director && `导演：${escape(short(info.director, 200))}`, info.series && `系列：${escape(short(info.series, 200))}`,
        info.date && `日期：${escape(short(info.date, 100))}`, info.duration && `时长：${escape(short(info.duration, 100))}`,
        info.actors.length && `演员：${escape(short(info.actors.join("、"), 700))}`,
        info.tags.length && `标签：${escape(short(info.tags.join("、"), 900))}`].filter(Boolean);
      const miss = `https://missav.ws/${encodeURIComponent(code)}`;
      const caption = [`<b>${escape(item.code || code)}</b>`, escape(short(item.title, 500)), ...fields,
        `评分：${escape(rating(info.score || item.score))}`, `<a href="${escape(item.link.href)}">JavDB</a> · <a href="${escape(miss)}">MissAV</a>`].join("\n");
      if (!item.thumb) { await context.telegram.edit(invocation.message, caption, {parseMode: "html", linkPreview: false}); return; }
      try {
        const cover = await image(context, item.thumb, item.link.href);
        await context.telegram.withClient(async client => {
          const {CustomFile} = await import("teleproto/client/uploads.js");
          const message = invocation.message.raw as Api.Message | undefined;
          if (!message?.peerId) throw new Error("Missing peer");
          await client.sendFile(message.peerId, {file: new CustomFile("cover.jpg", cover.length, "", cover), caption,
            parseMode: "html", spoiler: true, replyTo: invocation.message.replyToId});
          if (typeof message.delete === "function") await message.delete({revoke: true});
        });
      } catch {
        context.signal.throwIfAborted();
        await context.telegram.edit(invocation.message, caption, {parseMode: "html", linkPreview: false});
      }
    } catch {
      if (context.signal.aborted) return;
      context.log.error("javdb_failed");
      await context.telegram.edit(invocation.message, "番号查询失败，请稍后重试");
    }
  }};
  return definePlugin({apiVersion: 1, id: "javdb", description: "查询 JavDB 番号资料",
    commands: {javdb: command, av: command, jav: command, jd: command}});
}
