import { renderHelp as renderPluginHelp } from "./v2/help";
import { access, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { definePlugin, ui, type MessageEnvelope, type PluginContext } from "telebox/sdk";
import { Api, helpers, utils, type Api as ApiTypes } from "teleproto";
import type { EntityLike } from "teleproto/define";
import type { OverlayOptions } from "sharp";
const { encode } = require("modern-gif") as {
  encode(options: { width: number; height: number; frames: UnencodedFrame[] }): Promise<Uint8Array>;
};
type UnencodedFrame = { data: Buffer; delay: number };

const ROOT = "https://github.com/TeleBoxOrg/TeleBox-Plugins/raw/refs/heads/main/eatgif/";
const HOSTS = ["github.com", "raw.githubusercontent.com"] as const;
const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 512;
const MAX_ANIMATION_PIXELS = 16 * 1024 * 1024;
const MAX_FRAMES = 120;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
type Role = { x: number; y: number; mask: string; rotate?: number; brightness?: number };
type Entry = { url: string; delay?: number; me?: Role; you?: Role };
type Detail = { width: number; height: number; res: Entry[] };
type Catalog = Record<string, { url: string; desc: string }>;

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );
const renderList = (catalog: Catalog, prefix: string): string =>
  `<b>头像动图表情</b>\n<code>${escape(prefix)}eatgif 名称</code>（需回复目标）\n\n` +
  Object.entries(catalog)
    .map(([name, value]) => `• <code>${escape(name)}</code> - ${escape(value.desc)}`)
    .join("\n");
async function deliverList(
  context: PluginContext,
  message: MessageEnvelope,
  catalog: Catalog,
  prefix: string,
  missing?: string,
): Promise<void> {
  const source = `${missing ? `未找到：<code>${escape(missing)}</code>\n\n` : ""}${renderList(catalog, prefix)}`;
  const pages = (await ui.renderRichText(source, ui.PAGE_LABEL_RESERVE)).map(
    (page, index, all) => page + ui.pageLabel(index, all.length),
  );
  const delivery = await ui.deliverPages(pages, context.signal, (page, index) =>
    index
      ? context.telegram.reply(message, page, { parseMode: "html" })
      : context.telegram.edit(message, page, { parseMode: "html" }),
  );
  if (!delivery.interrupted) return;
  context.log.info("eatgif_pagination_interrupted", {
    published: delivery.published,
    total: delivery.total,
    category: ui.deliveryErrorCategory(delivery.error),
  });
  if (!delivery.published) throw delivery.error;
  try {
    await context.telegram.reply(message, ui.interruptedNotice(delivery), { parseMode: "html" });
  } catch {}
}
const safeRelative = (value: unknown): string => {
  const text = String(value ?? "");
  if (!text || text.includes("\\") || text.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("Invalid asset");
  return text;
};

export async function responseBytes(context: PluginContext, url: URL, maximum: number): Promise<Buffer> {
  return context.http.withResponse(
    url,
    { credentials: "omit" },
    async (response, signal) => {
      if (!response.ok || !response.body) throw new Error("Download failed");
      const reader = response.body.getReader();
      const parts: Buffer[] = [];
      let total = 0;
      let cancellation: Promise<void> | undefined;
      const cancel = () => (cancellation ??= reader.cancel().catch(() => undefined));
      const onAbort = () => {
        void cancel();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const item = await reader.read();
          signal.throwIfAborted();
          if (item.done) break;
          total += item.value.byteLength;
          if (total > maximum) throw new Error("Asset too large");
          parts.push(Buffer.from(item.value));
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        try {
          await cancel();
        } finally {
          reader.releaseLock();
        }
      }
      return Buffer.concat(parts);
    },
    { timeoutMs: 25_000, redirects: { allowedHosts: HOSTS, maxRedirects: 2 } },
  );
}
async function json<T>(context: PluginContext, relative: string): Promise<T> {
  const file = safeRelative(relative);
  const data = await responseBytes(context, new URL(file, ROOT), 1024 * 1024);
  try {
    return JSON.parse(data.toString("utf8")) as T;
  } catch {
    throw new Error("Invalid configuration");
  }
}
async function ffmpeg(context: PluginContext, cwd: string, args: readonly string[]) {
  for (const command of FFMPEG) {
    try {
      return await context.processes.run(command, args, { cwd, timeoutMs: 180_000, maxOutputBytes: 256 * 1024 });
    } catch (error) {
      context.signal.throwIfAborted();
      if ((error as { code?: unknown })?.code !== "SPAWN_FAILED") throw error;
      try {
        await access(command, constants.F_OK);
      } catch {
        continue;
      }
      throw error;
    }
  }
  throw new Error("FFmpeg unavailable");
}
export function validateDetail(detail: Detail): Detail {
  if (
    !Number.isInteger(detail?.width) ||
    !Number.isInteger(detail?.height) ||
    detail.width < 1 ||
    detail.height < 1 ||
    detail.width > MAX_DIMENSION ||
    detail.height > MAX_DIMENSION ||
    !Array.isArray(detail.res) ||
    detail.res.length < 1 ||
    detail.res.length > MAX_FRAMES ||
    detail.width * detail.height * detail.res.length > MAX_ANIMATION_PIXELS
  )
    throw new Error("Invalid animation");
  for (const entry of detail.res) {
    safeRelative(entry?.url);
    if (entry.delay !== undefined && (!Number.isFinite(entry.delay) || entry.delay < 1 || entry.delay > 5000))
      throw new Error("Invalid animation");
    for (const role of [entry.me, entry.you]) {
      if (!role) continue;
      safeRelative(role.mask);
      if (
        !Number.isInteger(role.x) ||
        !Number.isInteger(role.y) ||
        (role.rotate !== undefined && (!Number.isFinite(role.rotate) || role.rotate < -360 || role.rotate > 360)) ||
        (role.brightness !== undefined &&
          (!Number.isFinite(role.brightness) || role.brightness < 0.1 || role.brightness > 2))
      ) {
        throw new Error("Invalid animation");
      }
    }
  }
  return detail;
}

export async function downloadAvatarDirect(
  client: any,
  entityLike: EntityLike,
  signal: AbortSignal,
): Promise<Buffer | undefined> {
  signal.throwIfAborted();
  const entity =
    entityLike instanceof Api.User || entityLike instanceof Api.Chat || entityLike instanceof Api.Channel
      ? entityLike
      : await client.getEntity(entityLike);
  signal.throwIfAborted();
  if (!("photo" in entity)) return;
  const photo = entity.photo;
  if (!photo || photo instanceof Api.UserProfilePhotoEmpty || photo instanceof Api.ChatPhotoEmpty) return;
  const result = await client.invoke(
    new Api.upload.GetFile({
      location: new Api.InputPeerPhotoFileLocation({
        peer: utils.getInputPeer(entity),
        photoId: photo.photoId,
        big: false,
      }),
      offset: helpers.returnBigInt(0),
      limit: 512 * 1024,
      precise: true,
    }),
    photo.dcId,
  );
  signal.throwIfAborted();
  if (
    !(result instanceof Api.upload.File) ||
    !Buffer.isBuffer(result.bytes) ||
    !result.bytes.length ||
    result.bytes.length > MAX_AVATAR_BYTES
  )
    return;
  return result.bytes;
}
async function masked(
  sharp: typeof import("sharp"),
  loadAsset: (context: PluginContext, relative: string) => Promise<Buffer>,
  context: PluginContext,
  role: Role,
  face: Buffer,
): Promise<OverlayOptions> {
  const mask = await loadAsset(context, role.mask);
  const metadata = await sharp(mask, { limitInputPixels: MAX_ANIMATION_PIXELS }).metadata();
  const width = metadata.width,
    height = metadata.height;
  if (!width || !height || width > 512 || height > 512) throw new Error("Invalid mask");
  let image = await sharp(face, { limitInputPixels: MAX_ANIMATION_PIXELS }).resize(width, height).toBuffer();
  if (role.rotate)
    image = await sharp(image)
      .rotate(Math.max(-360, Math.min(360, role.rotate)))
      .toBuffer();
  if (role.brightness)
    image = await sharp(image)
      .modulate({ brightness: Math.max(0.1, Math.min(2, role.brightness)) })
      .toBuffer();
  const info = await sharp(image).metadata();
  const cropped = await sharp(image)
    .extract({
      left: Math.max(0, Math.floor(((info.width ?? width) - width) / 2)),
      top: Math.max(0, Math.floor(((info.height ?? height) - height) / 2)),
      width,
      height,
    })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  return { input: cropped, left: Math.trunc(role.x), top: Math.trunc(role.y) };
}

export async function uploadResult(
  context: PluginContext,
  raw: ApiTypes.Message,
  upload: string,
  webm: string,
  replyToId: number | undefined,
  tempSignal: AbortSignal,
): Promise<void> {
  await context.telegram.withClient(async (client, clientSignal) => {
    const signal = AbortSignal.any([context.signal, tempSignal, clientSignal]);
    signal.throwIfAborted();
    const { Api } = await import("teleproto");
    signal.throwIfAborted();
    await client.sendFile(raw.peerId, {
      file: upload,
      replyTo: replyToId,
      ...(upload === webm
        ? { attributes: [new Api.DocumentAttributeSticker({ alt: "✨", stickerset: new Api.InputStickerSetEmpty() })] }
        : {}),
    });
    signal.throwIfAborted();
    if (typeof raw.delete === "function") {
      try {
        await raw.delete({ revoke: true });
      } catch {
        context.log.info("eatgif_receipt_cleanup_failed");
      }
    }
    signal.throwIfAborted();
  });
}

export default function createEatGif() {
  let catalog: Catalog | undefined;
  let generation = 0;
  let catalogLoad: { generation: number; promise: Promise<Catalog> } | undefined;
  const assetLoads = new Map<string, { generation: number; promise: Promise<Buffer> }>();
  let stagingSequence = 0;
  let cacheMutation = Promise.resolve();
  const mutateCache = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = cacheMutation.then(operation, operation);
    cacheMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const getCatalog = async (context: PluginContext): Promise<Catalog> => {
    if (catalog) return catalog;
    const current = generation;
    if (catalogLoad?.generation === current) return catalogLoad.promise;
    const promise = json<Catalog>(context, "config.json")
      .then(value => {
        if (generation === current) catalog = value;
        return value;
      })
      .finally(() => {
        if (catalogLoad?.promise === promise) catalogLoad = undefined;
      });
    catalogLoad = { generation: current, promise };
    return promise;
  };
  const loadAsset = async (context: PluginContext, relative: string): Promise<Buffer> => {
    const value = safeRelative(relative);
    const key = createHash("sha256").update(value).digest("hex") + path.extname(value).slice(0, 8);
    const current = generation;
    const existing = assetLoads.get(key);
    if (existing?.generation === current) return existing.promise;
    const promise = (async () => {
      const target = await context.files.dataFile(`cache/${key}`);
      try {
        const info = await stat(target);
        context.signal.throwIfAborted();
        if (info.isFile() && info.size > 0 && info.size <= MAX_ASSET_BYTES) {
          const cached = await readFile(target, { signal: context.signal });
          context.signal.throwIfAborted();
          if (generation === current) return cached;
        }
      } catch {
        context.signal.throwIfAborted();
      }
      const data = await responseBytes(context, new URL(value, ROOT), MAX_ASSET_BYTES);
      await mutateCache(async () => {
        if (generation !== current) return;
        const staging = await context.files.dataFile(`cache/.${key}.${current}.${++stagingSequence}.part`);
        const handle = await open(staging, "wx", 0o600);
        try {
          await handle.writeFile(data);
        } finally {
          await handle.close();
        }
        try {
          if (generation === current) await rename(staging, target);
        } finally {
          await unlink(staging).catch(() => undefined);
        }
      });
      return data;
    })().finally(() => {
      if (assetLoads.get(key)?.promise === promise) assetLoads.delete(key);
    });
    assetLoads.set(key, { generation: current, promise });
    return promise;
  };
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "eatgif",
    description: "将双方头像合成为动画贴纸",
    resources: { processes: { concurrency: 1, queueCapacity: 1, timeoutMs: 180_000, maxOutputBytes: 256 * 1024 } },
    commands: {
      eatgif: {
        helpArgs: ["help", "h"],
        description: "生成头像融合动画",
        async handle(invocation, context) {
          const sub = invocation.args[0]?.toLowerCase() ?? "";
          try {
            if (sub === "clear") {
              await mutateCache(async () => {
                generation += 1;
                catalog = undefined;
                catalogLoad = undefined;
                assetLoads.clear();
                await rm(context.files.dataPath("cache"), { recursive: true, force: true });
              });
              await context.telegram.edit(invocation.message, "缓存已清理并将在下次请求时刷新");
              return;
            }
            const list = await getCatalog(context);
            if (!sub || sub === "list" || sub === "ls" || sub === "help" || sub === "h") {
              await deliverList(context, invocation.message, list, invocation.prefix);
              return;
            }
            const selected = list[sub];
            if (!selected) {
              await deliverList(context, invocation.message, list, invocation.prefix, sub);
              return;
            }
            if (invocation.message.replyToId === undefined) {
              await context.telegram.edit(invocation.message, "请回复一个用户的消息后再生成");
              return;
            }
            const reply = await context.telegram.getReply(invocation.message);
            const replyRaw = reply?.raw as ApiTypes.Message | undefined;
            const raw = invocation.message.raw as ApiTypes.Message | undefined;
            if (!raw?.peerId || !replyRaw?.senderId) throw new Error("Missing message");
            await context.telegram.edit(invocation.message, `正在生成：${selected.desc}`);
            const detail = validateDetail(await json<Detail>(context, selected.url));
            await context.files.withTemp(async (directory, signal) => {
              const { default: sharp } = await import("sharp");
              const target = replyRaw.sender ?? replyRaw.senderId;
              if (!target) throw new Error("Missing message");
              const faces = await context.telegram.withClient(async (client, clientSignal) => {
                const operationSignal = AbortSignal.any([context.signal, signal, clientSignal]);
                operationSignal.throwIfAborted();
                const meEntity = await client.getMe();
                operationSignal.throwIfAborted();
                const me = await downloadAvatarDirect(client, meEntity, operationSignal);
                operationSignal.throwIfAborted();
                const you = await downloadAvatarDirect(client, target, operationSignal);
                operationSignal.throwIfAborted();
                return { me, you };
              });
              if (!faces.me) {
                await context.telegram.edit(invocation.message, "无法获取自己的头像");
                return;
              }
              if (!faces.you) {
                await context.telegram.edit(invocation.message, "无法获取对方的头像");
                return;
              }
              const frames: UnencodedFrame[] = [];
              for (const entry of detail.res) {
                signal.throwIfAborted();
                const overlays: OverlayOptions[] = [];
                if (entry.you) overlays.push(await masked(sharp, loadAsset, context, entry.you, faces.you));
                if (entry.me) overlays.push(await masked(sharp, loadAsset, context, entry.me, faces.me));
                const canvas = await loadAsset(context, entry.url);
                const frame = sharp(canvas, { limitInputPixels: MAX_ANIMATION_PIXELS });
                const metadata = await frame.metadata();
                if (metadata.width !== detail.width || metadata.height !== detail.height)
                  throw new Error("Invalid frame");
                const data = await frame.composite(overlays).ensureAlpha().raw().toBuffer();
                frames.push({ data, delay: entry.delay ?? 100 });
              }
              const gif = path.join(directory, "output.gif"),
                webm = path.join(directory, "output.webm");
              const gifData = Buffer.from(await encode({ width: detail.width, height: detail.height, frames }));
              if (!gifData.length || gifData.length > MAX_OUTPUT_BYTES) throw new Error("Invalid output");
              const handle = await open(gif, "wx", 0o600);
              try {
                await handle.writeFile(gifData);
              } finally {
                await handle.close();
              }
              let upload = gif;
              try {
                await ffmpeg(context, directory, [
                  "-nostdin",
                  "-y",
                  "-protocol_whitelist",
                  "file",
                  "-i",
                  "output.gif",
                  "-c:v",
                  "libvpx-vp9",
                  "-b:v",
                  "0",
                  "-crf",
                  "41",
                  "-pix_fmt",
                  "yuva420p",
                  "-auto-alt-ref",
                  "0",
                  "-fs",
                  String(MAX_OUTPUT_BYTES),
                  "output.webm",
                ]);
                const output = await stat(webm);
                if (!output.size || output.size > MAX_OUTPUT_BYTES) throw new Error("Invalid output");
                upload = webm;
              } catch {
                signal.throwIfAborted();
                context.log.error("eatgif_ffmpeg_fallback");
              }
              await uploadResult(context, raw, upload, webm, invocation.message.replyToId, signal);
            });
          } catch {
            if (context.signal.aborted) return;
            context.log.error("eatgif_failed");
            await context.telegram.edit(
              invocation.message,
              "动图生成失败，请确认头像、远程素材、Sharp 与 FFmpeg 均可用",
            );
          }
        },
      },
    },
    cleanup() {
      generation += 1;
      catalog = undefined;
      catalogLoad = undefined;
      assetLoads.clear();
    },
  });
}
