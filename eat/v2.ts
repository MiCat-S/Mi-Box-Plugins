import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, type CommandInvocation, type PluginContext } from "telebox/sdk";
import type { Api as ApiTypes } from "teleproto";
import type { OverlayOptions } from "sharp";

const CONFIG_URL = "https://raw.githubusercontent.com/TeleBoxOrg/TeleBox-Plugins/refs/heads/main/eat/config.json";
const ALLOWED_HOSTS = ["raw.githubusercontent.com", "github.com"] as const;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_AVATAR_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_PIXELS = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 100;

type Role = { x: number; y: number; mask: string; brightness?: number; rotate?: number };
type Stamp = { size?: number; scale?: number; rotate?: number; opacity?: number };
type Entry = { name: string; url: string; me?: Role; you?: Role; stamp?: Stamp };
type Catalog = Record<string, Entry>;

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const allowed = (url: URL) =>
  url.protocol === "https:" &&
  !url.username &&
  !url.password &&
  ALLOWED_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));

async function read(context: PluginContext, url: URL, maximum: number): Promise<Buffer> {
  if (!allowed(url)) throw new Error("Invalid resource URL");
  return context.http.withResponse(
    url,
    { method: "GET", credentials: "omit", redirect: "manual" },
    async (response, signal) => {
      if (!response.ok || !response.body) throw new Error("Resource unavailable");
      const reader = response.body.getReader(),
        parts: Buffer[] = [];
      let total = 0,
        cancelling: Promise<void> | undefined;
      const cancel = () => (cancelling ??= reader.cancel().catch(() => undefined));
      const onAbort = () => {
        void cancel();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted();
          const item = await reader.read();
          signal.throwIfAborted();
          if (item.done) break;
          total += item.value.byteLength;
          if (total > maximum) throw new Error("Resource too large");
          parts.push(Buffer.from(item.value));
        }
        return Buffer.concat(parts, total);
      } finally {
        signal.removeEventListener("abort", onAbort);
        await cancel();
        reader.releaseLock();
      }
    },
    { timeoutMs: 30_000, signal: context.signal, redirects: { allowedHosts: ALLOWED_HOSTS, maxRedirects: 2 } },
  );
}

function rootFor(url: URL): URL {
  const match = /^\/([^/]+)\/([^/]+)\/refs\/heads\/([^/]+)\//.exec(url.pathname);
  if (url.hostname !== "raw.githubusercontent.com" || !match) throw new Error("Unsupported configuration URL");
  return new URL(`https://github.com/${match[1]}/${match[2]}/raw/${match[3]}/`);
}
function resource(root: URL, value: string): URL {
  const url = /^https:\/\//.test(value) ? new URL(value) : new URL(value.replace(/^\/+/, ""), root);
  if (!allowed(url)) throw new Error("Invalid resource URL");
  return url;
}
function catalog(value: unknown): Catalog {
  const resources = (value as { resources?: unknown })?.resources;
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) throw new Error("Invalid configuration");
  const result: Catalog = {};
  for (const [key, raw] of Object.entries(resources)) {
    const item = raw as Partial<Entry>;
    if (
      !/^[A-Za-z0-9_-]{1,40}$/.test(key) ||
      typeof item.name !== "string" ||
      !item.name ||
      item.name.length > 100 ||
      typeof item.url !== "string"
    )
      throw new Error("Invalid configuration");
    result[key] = {
      name: item.name,
      url: item.url,
      ...(item.me ? { me: item.me } : {}),
      ...(item.you ? { you: item.you } : {}),
      ...(item.stamp ? { stamp: item.stamp } : {}),
    };
  }
  if (!Object.keys(result).length || Object.keys(result).length > 200) throw new Error("Invalid configuration");
  return result;
}

function validRole(role: Role): Role {
  if (!Number.isFinite(role.x) || !Number.isFinite(role.y) || typeof role.mask !== "string")
    throw new Error("Invalid role");
  return {
    ...role,
    x: Math.trunc(role.x),
    y: Math.trunc(role.y),
    rotate: role.rotate === undefined ? undefined : Math.max(-360, Math.min(360, role.rotate)),
    brightness: role.brightness === undefined ? undefined : Math.max(0.1, Math.min(2, role.brightness)),
  };
}

async function exactId(value: string): Promise<unknown> {
  return (await import("teleproto/Helpers.js")).returnBigInt(value);
}

export default function createEat() {
  let current: Catalog | undefined, root: URL | undefined;
  const cache = new Map<string, Buffer>();
  const load = async (context: PluginContext, urlText = CONFIG_URL, force = false) => {
    if (current && !force) return current;
    const url = new URL(urlText);
    const parsed = catalog(JSON.parse((await read(context, url, MAX_CONFIG_BYTES)).toString("utf8")));
    current = parsed;
    root = rootFor(url);
    cache.clear();
    return parsed;
  };
  const asset = async (context: PluginContext, value: string) => {
    if (!root) throw new Error("Configuration unavailable");
    const url = resource(root, value),
      key = url.href,
      cached = cache.get(key);
    if (cached) return cached;
    const data = await read(context, url, MAX_ASSET_BYTES);
    cache.set(key, data);
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    return data;
  };
  const mask = async (
    sharp: typeof import("sharp"),
    context: PluginContext,
    roleValue: Role,
    avatar: Buffer,
  ): Promise<OverlayOptions> => {
    const role = validRole(roleValue),
      maskBytes = await asset(context, role.mask),
      meta = await sharp(maskBytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false, pages: 1 }).metadata();
    const width = meta.width,
      height = meta.height;
    if (!width || !height || width * height > MAX_INPUT_PIXELS) throw new Error("Invalid mask");
    let face = await sharp(avatar, { limitInputPixels: MAX_INPUT_PIXELS, animated: false, pages: 1 })
      .resize(width, height)
      .toBuffer();
    if (role.rotate) face = await sharp(face, { limitInputPixels: MAX_INPUT_PIXELS }).rotate(role.rotate).toBuffer();
    if (role.brightness)
      face = await sharp(face, { limitInputPixels: MAX_INPUT_PIXELS })
        .modulate({ brightness: role.brightness })
        .toBuffer();
    const info = await sharp(face, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    const prepared = await sharp(face, { limitInputPixels: MAX_INPUT_PIXELS })
      .extract({
        left: Math.max(0, Math.floor(((info.width ?? width) - width) / 2)),
        top: Math.max(0, Math.floor(((info.height ?? height) - height) / 2)),
        width,
        height,
      })
      .composite([{ input: maskBytes, blend: "dest-in" }])
      .png()
      .toBuffer();
    return { input: prepared, left: role.x, top: role.y };
  };
  const list = (items: Catalog) =>
    `当前表情包：\n${Object.keys(items)
      .sort((a, b) => a.localeCompare(b))
      .map(key => `${key} - ${items[key]!.name}`)
      .join("\n")}`;
  const run = async (invocation: CommandInvocation, context: PluginContext, media: boolean) => {
    const sub = invocation.args[0] ?? "";
    try {
      if (sub.toLowerCase() === "set" && invocation.message.replyToId === undefined) {
        await context.telegram.edit(invocation.message, "强制更新表情包配置中，请稍等...");
        const items = await load(context, invocation.args[1] || CONFIG_URL, true);
        await context.telegram.edit(invocation.message, `✅ 已强制更新表情包配置\n${list(items)}`);
        return;
      }
      const items = await load(context);
      if (invocation.message.replyToId === undefined) {
        await context.telegram.edit(invocation.message, list(items));
        return;
      }
      const entry = sub ? items[sub] : Object.values(items)[Math.floor(Math.random() * Object.keys(items).length)];
      if (!entry) {
        await context.telegram.edit(
          invocation.message,
          `找不到 ${sub} 该表情包，目前可用表情包如下:\n${list(items).slice("当前表情包：\n".length)}`,
        );
        return;
      }
      await context.telegram.edit(invocation.message, `正在生成 ${entry.name} 表情包···`);
      const reply = await context.telegram.getReply(invocation.message),
        replyRaw = reply?.raw as ApiTypes.Message | undefined;
      if (!reply) throw new Error("Reply unavailable");
      await context.telegram.withClient(async (client: any, signal) => {
        const { Api } = await import("teleproto");
        signal.throwIfAborted();
        let avatar: unknown;
        if (media) {
          if (!replyRaw?.media) {
            await context.telegram.edit(invocation.message, "请回复一条图片消息");
            return;
          }
          avatar = await client.downloadMedia(replyRaw, {
            thumb: (replyRaw.media as any)?.document?.mimeType === "video/webm" ? 0 : 1,
          });
        } else {
          const target = reply.senderId ? await exactId(reply.senderId) : replyRaw?.senderId;
          if (!target) {
            await context.telegram.edit(invocation.message, "无法获取对方头像");
            return;
          }
          avatar = await client.downloadProfilePhoto(target, { isBig: false });
        }
        signal.throwIfAborted();
        if (!Buffer.isBuffer(avatar) || !avatar.length || avatar.length > MAX_AVATAR_BYTES)
          throw new Error("Avatar unavailable");
        const { default: sharp } = await import("sharp");
        signal.throwIfAborted();
        const base = await asset(context, entry.url);
        let output: Buffer;
        if (entry.stamp) {
          const cfg = entry.stamp,
            size = Math.max(1, Math.min(2048, Math.trunc(cfg.size ?? 512))),
            scale = Math.max(0.05, Math.min(4, cfg.scale ?? 0.9)),
            opacity = Math.max(0, Math.min(1, cfg.opacity ?? 0.6));
          const canvas = await sharp(avatar, { limitInputPixels: MAX_INPUT_PIXELS, animated: false, pages: 1 })
              .resize(size, size, { fit: "cover" })
              .png()
              .toBuffer(),
            stamp = await sharp(base, { limitInputPixels: MAX_INPUT_PIXELS, animated: false, pages: 1 })
              .resize({ width: Math.round(size * scale) })
              .rotate(Math.max(-360, Math.min(360, cfg.rotate ?? -12)), { background: { r: 0, g: 0, b: 0, alpha: 0 } })
              .ensureAlpha()
              .linear([1, 1, 1, opacity], [0, 0, 0, 0])
              .resize({ width: size, height: size, fit: "inside" })
              .png()
              .toBuffer();
          output = await sharp(canvas, { limitInputPixels: MAX_INPUT_PIXELS })
            .composite([{ input: stamp, gravity: "center" }])
            .webp({ lossless: true })
            .toBuffer();
        } else {
          const overlays: OverlayOptions[] = [];
          if (entry.you) overlays.push(await mask(sharp, context, entry.you, avatar));
          if (entry.me) {
            if (!invocation.message.senderId) throw new Error("Sender unavailable");
            const own = await client.downloadProfilePhoto(await exactId(invocation.message.senderId), { isBig: false });
            signal.throwIfAborted();
            if (!Buffer.isBuffer(own) || !own.length || own.length > MAX_AVATAR_BYTES)
              throw new Error("Avatar unavailable");
            overlays.push(await mask(sharp, context, entry.me, own));
          }
          output = await sharp(base, { limitInputPixels: MAX_INPUT_PIXELS, animated: false, pages: 1 })
            .composite(overlays)
            .webp({ quality: 100 })
            .toBuffer();
        }
        signal.throwIfAborted();
        if (!output.length || output.length > 20 * 1024 * 1024) throw new Error("Invalid output");
        const dimensions = await sharp(output, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
        signal.throwIfAborted();
        const peer =
          (invocation.message.raw as ApiTypes.Message | undefined)?.peerId ??
          (await exactId(invocation.message.chatId));
        const { CustomFile } = await import("teleproto/client/uploads.js");
        signal.throwIfAborted();
        await client.sendFile(peer, {
          file: new CustomFile("output.webp", output.length, "", output),
          forceDocument: false,
          attributes: [
            new Api.DocumentAttributeSticker({ alt: entry.name, stickerset: new Api.InputStickerSetEmpty() }),
            new Api.DocumentAttributeImageSize({ w: dimensions.width ?? 512, h: dimensions.height ?? 512 }),
            new Api.DocumentAttributeFilename({ fileName: "output.webp" }),
          ],
          replyTo: invocation.message.replyToId,
        });
        signal.throwIfAborted();
        const raw = invocation.message.raw as ApiTypes.Message | undefined;
        if (typeof raw?.delete === "function") {
          try {
            await raw.delete({ revoke: true });
          } catch {
            context.log.error("eat_delete_failed");
          }
        }
      });
    } catch {
      if (context.signal.aborted) return;
      context.log.error("eat_failed");
      await context.telegram.edit(invocation.message, "表情包生成失败，请确认回复内容和远程素材可用");
    }
  };
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "eat",
    description: "生成带头像表情包",
    commands: {
      eat: { description: "使用回复用户头像生成表情包", handle: (i, c) => run(i, c, false) },
      eat2: { description: "使用回复图片生成表情包", handle: (i, c) => run(i, c, true) },
    },
    cleanup() {
      current = undefined;
      root = undefined;
      cache.clear();
    },
  });
}
