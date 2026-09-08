import {renderHelp as renderPluginHelp} from "./v2/help";
import {access, open, readFile, rm, stat} from "node:fs/promises";
import {constants} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";
import type {OverlayOptions} from "sharp";
const {encode} = require("modern-gif") as {encode(options: {width: number; height: number; frames: UnencodedFrame[]}): Promise<Uint8Array>};
type UnencodedFrame = {data: Buffer; delay: number};

const ROOT = "https://github.com/TeleBoxOrg/TeleBox-Plugins/raw/refs/heads/main/eatgif/";
const HOSTS = ["github.com", "raw.githubusercontent.com"] as const;
const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
type Role = {x: number; y: number; mask: string; rotate?: number; brightness?: number};
type Entry = {url: string; delay?: number; me?: Role; you?: Role};
type Detail = {width: number; height: number; res: Entry[]};
type Catalog = Record<string, {url: string; desc: string}>;

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;"})[character]!);
const safeRelative = (value: unknown): string => {
  const text = String(value ?? "");
  if (!text || text.includes("\\") || text.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid asset");
  return text;
};

async function bytes(context: PluginContext, url: URL, maximum: number): Promise<Buffer> {
  return context.http.withResponse(url, {credentials: "omit"}, async (response, signal) => {
    if (!response.ok || !response.body) throw new Error("Download failed");
    const reader = response.body.getReader(); const parts: Buffer[] = []; let total = 0;
    try { while (true) { signal.throwIfAborted(); const item = await reader.read(); if (item.done) break;
        total += item.value.byteLength; if (total > maximum) throw new Error("Asset too large"); parts.push(Buffer.from(item.value)); } }
    finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(parts);
  }, {timeoutMs: 25_000, redirects: {allowedHosts: HOSTS, maxRedirects: 2}});
}
async function json<T>(context: PluginContext, relative: string): Promise<T> {
  const file = safeRelative(relative); const data = await bytes(context, new URL(file, ROOT), 1024 * 1024);
  try { return JSON.parse(data.toString("utf8")) as T; } catch { throw new Error("Invalid configuration"); }
}
async function asset(context: PluginContext, relative: string): Promise<Buffer> {
  const value = safeRelative(relative); const key = createHash("sha256").update(value).digest("hex") + path.extname(value).slice(0, 8);
  const target = await context.files.dataFile(`cache/${key}`);
  try { const info = await stat(target); if (info.isFile() && info.size > 0 && info.size <= 5 * 1024 * 1024) return readFile(target); } catch {}
  const data = await bytes(context, new URL(value, ROOT), 5 * 1024 * 1024);
  const handle = await open(target, "w", 0o600); try { await handle.writeFile(data); } finally { await handle.close(); }
  return data;
}
async function ffmpeg(context: PluginContext, args: readonly string[]) {
  for (const command of FFMPEG) {
    try { return await context.processes.run(command, args, {timeoutMs: 180_000, maxOutputBytes: 256 * 1024}); }
    catch (error) { context.signal.throwIfAborted(); if ((error as {code?: unknown})?.code !== "SPAWN_FAILED") throw error;
      try { await access(command, constants.F_OK); } catch { continue; } throw error; }
  }
  throw new Error("FFmpeg unavailable");
}
function validate(detail: Detail): Detail {
  if (!Number.isInteger(detail?.width) || !Number.isInteger(detail?.height) || detail.width < 1 || detail.height < 1 ||
      detail.width > 512 || detail.height > 512 || !Array.isArray(detail.res) || detail.res.length < 1 || detail.res.length > 60) throw new Error("Invalid animation");
  return detail;
}
async function avatar(client: any, entity: any): Promise<Buffer | undefined> {
  const value = await client.downloadProfilePhoto(entity, {isBig: false});
  if (!Buffer.isBuffer(value) || !value.length || value.length > 2 * 1024 * 1024) return;
  return value;
}
async function masked(sharp: typeof import("sharp"), context: PluginContext, role: Role, face: Buffer): Promise<OverlayOptions> {
  const mask = await asset(context, role.mask); const metadata = await sharp(mask).metadata();
  const width = metadata.width, height = metadata.height;
  if (!width || !height || width > 512 || height > 512) throw new Error("Invalid mask");
  let image = await sharp(face).resize(width, height).toBuffer();
  if (role.rotate) image = await sharp(image).rotate(Math.max(-360, Math.min(360, role.rotate))).toBuffer();
  if (role.brightness) image = await sharp(image).modulate({brightness: Math.max(0.1, Math.min(2, role.brightness))}).toBuffer();
  const info = await sharp(image).metadata();
  const cropped = await sharp(image).extract({left: Math.max(0, Math.floor(((info.width ?? width) - width) / 2)),
    top: Math.max(0, Math.floor(((info.height ?? height) - height) / 2)), width, height})
    .composite([{input: mask, blend: "dest-in"}]).png().toBuffer();
  return {input: cropped, left: Math.trunc(role.x), top: Math.trunc(role.y)};
}

export default function createEatGif() {
  let catalog: Catalog | undefined;
  const getCatalog = async (context: PluginContext): Promise<Catalog> => catalog ??= await json<Catalog>(context, "config.json");
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "eatgif", description: "将双方头像合成为动画贴纸",
    resources: {processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 180_000, maxOutputBytes: 256 * 1024}},
    commands: {eatgif: {helpArgs: ["help","h"], description: "生成头像融合动画", async handle(invocation, context) {
      const sub = invocation.args[0]?.toLowerCase() ?? "";
      try {
        if (sub === "clear") { await rm(context.files.dataPath("cache"), {recursive: true, force: true}); catalog = undefined;
          await context.telegram.edit(invocation.message, "缓存已清理并将在下次请求时刷新"); return; }
        const list = await getCatalog(context);
        if (!sub || sub === "list" || sub === "ls" || sub === "help" || sub === "h") {
          await context.telegram.edit(invocation.message, `<b>头像动图表情</b>\n<code>${escape(invocation.prefix)}eatgif 名称</code>（需回复目标）\n\n` +
            Object.entries(list).map(([name, value]) => `• <code>${escape(name)}</code> - ${escape(value.desc)}`).join("\n"), {parseMode: "html"}); return;
        }
        const selected = list[sub]; if (!selected) { await context.telegram.edit(invocation.message, `未找到：<code>${escape(sub)}</code>`, {parseMode: "html"}); return; }
        if (invocation.message.replyToId === undefined) { await context.telegram.edit(invocation.message, "请回复一个用户的消息后再生成"); return; }
        const reply = await context.telegram.getReply(invocation.message); const replyRaw = reply?.raw as ApiTypes.Message | undefined;
        const raw = invocation.message.raw as ApiTypes.Message | undefined; if (!raw?.peerId || !replyRaw?.senderId) throw new Error("Missing message");
        await context.telegram.edit(invocation.message, `正在生成：${selected.desc}`);
        const detail = validate(await json<Detail>(context, selected.url));
        await context.files.withTemp(async (directory, signal) => {
          const {default: sharp} = await import("sharp");
          const faces = await context.telegram.withClient(async client => ({me: await avatar(client, await client.getMe()), you: await avatar(client, replyRaw.sender ?? replyRaw.senderId)}));
          if (!faces.me || !faces.you) throw new Error("Avatar unavailable");
          const frames: UnencodedFrame[] = [];
          for (const entry of detail.res) {
            signal.throwIfAborted(); const overlays: OverlayOptions[] = [];
            if (entry.you) overlays.push(await masked(sharp, context, entry.you, faces.you));
            if (entry.me) overlays.push(await masked(sharp, context, entry.me, faces.me));
            const canvas = await asset(context, entry.url);
            const data = await sharp(canvas).composite(overlays).ensureAlpha().raw().toBuffer();
            frames.push({data, delay: Math.max(20, Math.min(5000, Number(entry.delay) || 100))});
          }
          const gif = path.join(directory, "output.gif"), webm = path.join(directory, "output.webm");
          const handle = await open(gif, "wx", 0o600); try { await handle.writeFile(Buffer.from(await encode({width: detail.width, height: detail.height, frames}))); } finally { await handle.close(); }
          await ffmpeg(context, ["-nostdin", "-y", "-i", gif, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "41", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", webm]);
          const output = await stat(webm); if (!output.size || output.size > 20 * 1024 * 1024) throw new Error("Invalid output");
          await context.telegram.withClient(async client => { const {Api} = await import("teleproto");
            await client.sendFile(raw.peerId, {file: webm, replyTo: invocation.message.replyToId,
              attributes: [new Api.DocumentAttributeSticker({alt: "✨", stickerset: new Api.InputStickerSetEmpty()})]});
            if (typeof raw.delete === "function") await raw.delete({revoke: true}); });
        });
      } catch { if (context.signal.aborted) return; context.log.error("eatgif_failed");
        await context.telegram.edit(invocation.message, "动图生成失败，请确认头像、远程素材、Sharp 与 FFmpeg 均可用"); }
    }}}, cleanup() { catalog = undefined; },
  });
}
