import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api} from "teleproto";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const CATEGORIES: Readonly<Record<string, {categories?: string; tags: readonly string[]}>> = {
  meizi: {categories: "001", tags: ["photography", "portrait", "aesthetic"]},
  dongman: {categories: "010", tags: ["anime", "illustration", "digital painting", "Studio Ghibli"]},
  fengjing: {categories: "100", tags: ["nature", "Japan", "night", "architecture", "oil painting"]},
  suiji: {tags: ["anime", "oil painting", "photography", "Japan", "night", "illustration"]},
};

type Wallpaper = {id: string; path: string; dimension_x: number; dimension_y: number; file_size: number; file_type: string};
type Download = {data: Buffer; filename: string; source: string};

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

async function image(context: PluginContext, url: URL): Promise<Buffer> {
  return context.http.withResponse(url, {
    method: "GET", redirect: "manual", credentials: "omit",
    headers: {Accept: "image/*", "User-Agent": "MiBot-Bizhi/2.0"},
  }, async (response, signal) => {
    if (response.status !== 200 || !response.body) throw new Error("Image unavailable");
    const type = response.headers.get("content-type") ?? "";
    if (type && !type.toLowerCase().startsWith("image/")) throw new Error("Invalid image type");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > MAX_IMAGE_BYTES) throw new Error("Image too large");
        chunks.push(part.value);
      }
      return Buffer.concat(chunks, total);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }, {timeoutMs: 120_000, signal: context.signal, redirects:{allowedHosts:[url.hostname],maxRedirects:2}});
}

function safeImageUrl(value: unknown, hosts: readonly string[]): URL {
  if (typeof value !== "string") throw new Error("Invalid image URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error("Invalid image URL");
  }
  return url;
}

async function wallhaven(context: PluginContext, category: string): Promise<Download> {
  const config = CATEGORIES[category] ?? CATEGORIES.suiji!;
  const sortingRoll = Math.random();
  const sorting = sortingRoll < 0.6 ? "random" : sortingRoll < 0.85 ? "favorites" : "date_added";
  const params = new URLSearchParams({sorting, purity: "100", per_page: "24", atleast: "1920x1080", ratios: "16x9"});
  if (sorting === "random") params.set("seed", Math.random().toString(36).slice(2, 8).padEnd(6, "0"));
  else params.set("order", "desc");
  if (config.categories) params.set("categories", config.categories);
  const tag = config.tags[Math.floor(Math.random() * config.tags.length)];
  if (tag) params.set("q", tag);
  const response = await context.http.json<unknown>(`https://wallhaven.cc/api/v1/search?${params}`, {
    method: "GET", redirect: "manual", credentials: "omit", headers: {Accept: "application/json", "User-Agent": "MiBot-Bizhi/2.0"},
  }, {timeoutMs: 60_000, signal: context.signal, redirects:{allowedHosts:["wallhaven.cc"],maxRedirects:2}});
  const entries = (response as {data?: unknown})?.data;
  if (!Array.isArray(entries)) throw new Error("Invalid Wallhaven response");
  const valid = entries.filter(value => {
    const item = value as Partial<Wallpaper>;
    return typeof item.id === "string" && typeof item.path === "string" && Number.isFinite(item.dimension_x) &&
      Number.isFinite(item.dimension_y) && Number.isFinite(item.file_size);
  }) as Wallpaper[];
  if (!valid.length) throw new Error("No wallpaper");
  const qualified = valid.filter(item => item.dimension_x >= 1920 && item.dimension_y >= 1080 && item.file_size >= 3 * 1024 * 1024);
  const selected = (qualified.length ? qualified : valid)[Math.floor(Math.random() * (qualified.length ? qualified.length : valid.length))]!;
  const url = safeImageUrl(selected.path, ["wallhaven.cc"]);
  const extension = selected.file_type === "image/png" ? "png" : selected.file_type === "image/webp" ? "webp" : "jpg";
  return {
    data: await image(context, url), filename: `wallhaven_${selected.id}_${selected.dimension_x}x${selected.dimension_y}.${extension}`,
    source: `${url.href}\n${selected.dimension_x}×${selected.dimension_y} · ${(selected.file_size / 1048576).toFixed(2)} MB`,
  };
}

async function fallback(context: PluginContext, category: string): Promise<Download> {
  const url = new URL("https://api.btstu.cn/sjbz/api.php");
  url.searchParams.set("method", "pc");
  url.searchParams.set("format", "json");
  if (category) url.searchParams.set("lx", category);
  const response = await context.http.json<unknown>(url, {method: "GET", redirect: "manual", credentials: "omit"}, {timeoutMs: 60_000, signal: context.signal, redirects:{allowedHosts:["api.btstu.cn"],maxRedirects:2}});
  const value = response as {code?: unknown; imgurl?: unknown};
  if (String(value.code) !== "200") throw new Error("Fallback unavailable");
  const target = safeImageUrl(value.imgurl, ["btstu.cn"]);
  return {data: await image(context, target), filename: `bizhi_${category || "suiji"}.jpg`, source: `${target.href}\n来源：btstu.cn`};
}

export default function createBizhi() {
  return definePlugin({apiVersion: 1, id: "bizhi", description: "随机获取高品质桌面壁纸",
    commands: {bizhi: {description: "随机获取高品质桌面壁纸", async handle(invocation, context) {
      const sendAsFile = invocation.args.includes("-f");
      const category = invocation.args.find(value => !value.startsWith("-"))?.toLowerCase() ?? "";
      if (category && !Object.hasOwn(CATEGORIES, category) || invocation.args.some(value => value.startsWith("-") && value !== "-f")) {
        await context.telegram.edit(invocation.message,
          `<b>高品质壁纸</b>\n<code>${escape(invocation.prefix)}bizhi [meizi|dongman|fengjing|suiji] [-f]</code>`, {parseMode: "html"});
        return;
      }
      await context.telegram.edit(invocation.message, "正在获取高品质壁纸…");
      try {
        let result: Download;
        try { result = await wallhaven(context, category); }
        catch { context.signal.throwIfAborted(); result = await fallback(context, category); }
        if (!result.data.length) throw new Error("Empty image");
        await context.telegram.withClient(async client => {
          const {CustomFile} = await import("teleproto/client/uploads.js");
          const raw = invocation.message.raw as Api.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          const file = new CustomFile(result.filename, result.data.length, "", result.data);
          await client.sendFile(raw.peerId, {file, replyTo: invocation.message.replyToId ?? invocation.message.id,
            caption: `${sendAsFile ? "源文件" : "壁纸来源"}：${result.source}`, forceDocument: sendAsFile});
          if (typeof raw.delete === "function") await raw.delete({revoke: true});
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("bizhi_failed");
        await context.telegram.edit(invocation.message, "获取壁纸失败，请稍后重试");
      }
    }}},
  });
}
