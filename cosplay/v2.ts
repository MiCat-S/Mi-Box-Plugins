import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type PluginContext} from "telebox/sdk";
import path from "node:path";
import {open, stat} from "node:fs/promises";
import {load} from "cheerio";
import type {Api as ApiTypes} from "teleproto";

const HOST = "cosplaytele.com";
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const USER_AGENT = "MiBot-Cosplay/2.0";
const EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function safeUrl(value: string, base: URL): URL | undefined {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.username || url.password || !(url.hostname === HOST || url.hostname.endsWith(`.${HOST}`))) return;
    return url;
  } catch { return; }
}

async function page(context: PluginContext, url: URL): Promise<string> {
  return context.http.withResponse(url, {method: "GET", credentials: "omit", headers: {Accept: "text/html", "User-Agent": USER_AGENT}},
    async (response, signal) => {
      if (response.status !== 200 || !response.body) throw new Error("Page unavailable");
      const type = response.headers.get("content-type") ?? "";
      if (type && !type.toLowerCase().includes("text/html")) throw new Error("Invalid page type");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); const parts: string[] = []; let total = 0;
      try {
        for (;;) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
          total += part.value.byteLength; if (total > 2 * 1024 * 1024) throw new Error("Page too large"); parts.push(decoder.decode(part.value, {stream: true})); }
        return parts.join("") + decoder.decode();
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    }, {timeoutMs: 30_000, signal: context.signal, redirects: {allowedHosts: [HOST], maxRedirects: 3}});
}

function sets(html: string, base: URL): URL[] {
  const $ = load(html); const found = new Map<string, URL>();
  $("a[href]").each((_index, element) => {
    const url = safeUrl($(element).attr("href") ?? "", base);
    if (!url || url.hash || !/^\/[a-z0-9-]+\/$/i.test(url.pathname) ||
        /^\/(?:page|category|24-hours|3-day|7-day|explore-categories|best-cosplayer|feed|comments|top-search)(?:\/|$)/.test(url.pathname)) return;
    found.set(url.href, url);
  });
  return [...found.values()].slice(0, 200);
}

function gallery(html: string, base: URL): URL[] {
  const $ = load(html); const found = new Map<string, URL>();
  $("figure.gallery-item img[src]").each((_index, element) => {
    const url = safeUrl($(element).attr("src") ?? "", base);
    if (url && EXTENSIONS.has(path.extname(url.pathname).toLowerCase())) found.set(url.href, url);
  });
  return [...found.values()].slice(0, 100);
}

function pick<T>(values: readonly T[], count: number): T[] {
  const pool = [...values]; const result: T[] = [];
  while (pool.length && result.length < count) result.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!);
  return result;
}

async function download(context: PluginContext, url: URL, file: string): Promise<void> {
  await context.http.withResponse(url, {method: "GET", credentials: "omit", headers: {Accept: "image/*", Referer: `https://${HOST}/`, "User-Agent": USER_AGENT}},
    async (response, signal) => {
      if (response.status !== 200 || !response.body || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) throw new Error("Invalid image");
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > MAX_IMAGE_BYTES) throw new Error("Image too large");
      const handle = await open(file, "wx", 0o600); const reader = response.body.getReader(); let total = 0;
      try {
        for (;;) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
          total += part.value.byteLength; if (total > MAX_IMAGE_BYTES) throw new Error("Image too large"); await handle.write(part.value); }
        if (!total) throw new Error("Empty image");
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await handle.close(); }
    }, {timeoutMs: 45_000, signal: context.signal, redirects: {allowedHosts: [HOST], maxRedirects: 3}});
}

async function find(context: PluginContext, count: number): Promise<{set: URL; title: string; images: URL[]}> {
  for (let attempt = 0; attempt < 6; attempt++) {
    context.signal.throwIfAborted();
    const pageNumber = Math.floor(Math.random() * 455) + 1;
    const listing = new URL(pageNumber === 1 ? `https://${HOST}/` : `https://${HOST}/page/${pageNumber}/`);
    const candidates = sets(await page(context, listing), listing);
    if (!candidates.length) continue;
    const selected = candidates[Math.floor(Math.random() * candidates.length)]!;
    const images = gallery(await page(context, selected), selected);
    if (images.length >= count) return {set: selected, title: selected.pathname.split("/").filter(Boolean).at(-1)?.replace(/-/g, " ") || "Cosplay", images: pick(images, count)};
  }
  throw new Error("No photo set");
}

async function run(invocation: any, context: PluginContext): Promise<void> {
  const parsed = invocation.args[0] === undefined ? 1 : Number(invocation.args[0]);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_IMAGES) {
    await context.telegram.edit(invocation.message, `数量必须是 1 到 ${MAX_IMAGES} 的整数`); return;
  }
  await context.telegram.edit(invocation.message, `正在从随机套图中获取 ${parsed} 张图片…`);
  try {
    const result = await find(context, parsed);
    await context.files.withTemp(async (directory, signal) => {
      const files: string[] = [];
      let cursor = 0;
      const worker = async () => { while (cursor < result.images.length) { const index = cursor++; const url = result.images[index]!;
        const file = path.join(directory, `${index}${path.extname(url.pathname).toLowerCase() || ".jpg"}`); await download(context, url, file); files[index] = file; } };
      await Promise.all(Array.from({length: Math.min(3, result.images.length)}, worker));
      signal.throwIfAborted();
      await context.telegram.withClient(async client => {
        const {CustomFile} = await import("teleproto/client/uploads.js");
        const raw = invocation.message.raw as ApiTypes.Message | undefined;
        if (!raw?.peerId) throw new Error("Missing peer");
        for (let index = 0; index < files.length; index++) {
          signal.throwIfAborted(); const info = await stat(files[index]!);
          await client.sendFile(raw.peerId, {file: new CustomFile(path.basename(files[index]!), info.size, files[index]!), spoiler: true,
            caption: index === 0 ? `套图链接: ${result.set.href}` : "", replyTo: index === 0 ? invocation.message.replyToId : undefined});
        }
        if (typeof raw.delete === "function") await raw.delete({revoke: true});
      });
    });
  } catch {
    if (context.signal.aborted) return;
    context.log.error("cosplay_failed");
    await context.telegram.edit(invocation.message, "获取 Cosplay 图片失败，请稍后重试");
  }
}

const cosplayCommand: CommandDefinition = {
  description: "从随机套图获取 Cosplay 图片",
  args: "[数量]",
  arguments: [{name: "数量", description: "获取图片数量，默认 1，最大 10"}],
  examples: [{args: ""}, {args: "3"}],
  help: [
    {heading: "说明：", body: "从 cosplaytele.com 随机选择套图，确保多张图片来自同一套图，只获取高质量的 gallery 图片；发送图片时自动包含原套图链接。"},
    {heading: "别名：", body: "<code>{prefix}cos</code> 与 cosplay 相同。"},
  ],
  handle: run,
};

export default function createCosplay() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "cosplay", description: "从 cosplaytele.com 获取同一套图中的随机图片",
    renderHelp: prefix => renderCommandHelp("cosplay", cosplayCommand, {prefix, title: "从 cosplaytele.com 随机获取cosplay图片"}),
    commands: {cos: cosplayCommand, cosplay: cosplayCommand}});
}
