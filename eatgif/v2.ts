import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type PluginContext, type SubcommandDefinition} from "telebox/sdk";
import {access, open, readFile, rename, rm, stat, unlink} from "node:fs/promises";
import {constants} from "node:fs";
import {createHash, randomUUID} from "node:crypto";
import path from "node:path";
import type {Api as ApiTypes} from "teleproto";
import type {OverlayOptions} from "sharp";
const {encode} = require("modern-gif") as {encode(options: {width: number; height: number; frames: UnencodedFrame[]}): Promise<Uint8Array>};
type UnencodedFrame = {data: Buffer; delay: number};

const ROOT = "https://github.com/TeleBoxOrg/TeleBox-Plugins/raw/refs/heads/main/eatgif/";
const HOSTS = ["github.com", "raw.githubusercontent.com"] as const;
const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const MAX_IMAGE_PIXELS = 16_777_216;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
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
    const reader = response.body.getReader(); const parts: Buffer[] = []; let total = 0, done = false;
    try { while (true) { signal.throwIfAborted(); const item = await reader.read(); if (item.done) {done = true; break;}
        total += item.value.byteLength; if (total > maximum) throw new Error("Asset too large"); parts.push(Buffer.from(item.value)); } }
    finally { try {if (!done) await reader.cancel();} catch {} finally {reader.releaseLock();} }
    return Buffer.concat(parts);
  }, {timeoutMs: 25_000, redirects: {allowedHosts: HOSTS, maxRedirects: 2}});
}
async function json<T>(context: PluginContext, relative: string): Promise<T> {
  const file = safeRelative(relative); const data = await bytes(context, new URL(file, ROOT), 1024 * 1024);
  try { return JSON.parse(data.toString("utf8")) as T; } catch { throw new Error("Invalid configuration"); }
}
async function ffmpeg(context: PluginContext, args: readonly string[], cwd: string, signal: AbortSignal) {
  for (const command of FFMPEG) {
    try { return await context.processes.run(command, args, {timeoutMs: 180_000, maxOutputBytes: 256 * 1024, cwd, signal}); }
    catch (error) { signal.throwIfAborted(); if ((error as {code?: unknown})?.code !== "SPAWN_FAILED") throw error;
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
const boundedSharp = (sharp: typeof import("sharp"), input: Buffer) => sharp(input, {limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error"});
async function masked(sharp: typeof import("sharp"), asset: (relative:string)=>Promise<Buffer>, role: Role, face: Buffer): Promise<OverlayOptions> {
  const mask = await asset(role.mask); const metadata = await boundedSharp(sharp, mask).metadata();
  const width = metadata.width, height = metadata.height;
  if (!width || !height || width > 512 || height > 512) throw new Error("Invalid mask");
  let image = await boundedSharp(sharp, face).resize(width, height).toBuffer();
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
  let cacheTail=Promise.resolve();
  const serial=<T>(operation:()=>Promise<T>):Promise<T>=>{const result=cacheTail.then(operation,operation);cacheTail=result.then(()=>undefined,()=>undefined);return result;};
  const getCatalog = (context: PluginContext): Promise<Catalog> => catalog ? Promise.resolve(catalog) : serial(async()=>catalog??=await json<Catalog>(context,"config.json"));
  const asset = (context:PluginContext, relative:string):Promise<Buffer> => serial(async()=>{
    const value=safeRelative(relative),key=createHash("sha256").update(value).digest("hex")+path.extname(value).slice(0,8);
    const target=await context.files.dataFile(`cache/${key}`);
    try{const info=await stat(target);if(info.isFile()&&info.size>0&&info.size<=MAX_ASSET_BYTES){const cached=await readFile(target);if(cached.length>0&&cached.length<=MAX_ASSET_BYTES)return cached;}await unlink(target);}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const data=await bytes(context,new URL(value,ROOT),MAX_ASSET_BYTES),temporary=`${target}.${randomUUID()}.tmp`;
    try{const handle=await open(temporary,"wx",0o600);try{await handle.writeFile(data);}finally{await handle.close();}await rename(temporary,target);}
    finally{await unlink(temporary).catch(error=>{if(error.code!=="ENOENT")throw error;});}
    return data;
  });
  const guard = (operation: SubcommandDefinition["handle"]): SubcommandDefinition["handle"] => async (invocation, context) => {
    try { await operation(invocation, context); }
    catch {
      if (context.signal.aborted) return;
      context.log.error("eatgif_failed");
      await context.telegram.edit(invocation.message, "动图生成失败，请确认头像、远程素材、Sharp 与 FFmpeg 均可用");
    }
  };
  const showList = async (invocation: any, context: PluginContext) => {
    const list = await getCatalog(context);
    await context.telegram.edit(invocation.message, `<b>头像动图表情</b>\n<code>${escape(invocation.prefix)}eatgif 名称</code>（需回复目标）\n\n` +
      Object.entries(list).map(([name, value]) => `• <code>${escape(name)}</code> - ${escape(value.desc)}`).join("\n"), {parseMode: "html"});
  };
  const clear: SubcommandDefinition = {
    description: "清理缓存并重新下载素材", args: "", examples: [{args: "clear"}],
    handle: guard(async (invocation, context) => { await serial(async()=>{await rm(context.files.dataPath("cache"),{recursive:true,force:true});catalog=undefined;});
      await context.telegram.edit(invocation.message, "缓存已清理并将在下次请求时刷新"); }),
  };
  const list: SubcommandDefinition = {
    description: "查看表情列表", args: "", aliases: ["ls"], examples: [{args: "list"}],
    handle: guard(showList),
  };
  const eatgifCommand: CommandDefinition = {
    description: "生成头像融合动画",
    helpArgs: ["help", "h"],
    args: "[名称]",
    arguments: [{name: "名称", description: "表情名称；省略或 list 查看列表"}],
    examples: [{args: ""}, {args: "list"}, {args: "名称", description: "回复目标用户后生成"}],
    subcommandsCaseSensitive: false,
    subcommands: {clear, list},
    help: [
      {heading: "用法：", body: "空或 <code>{prefix}eatgif list</code> 查看表情列表；回复目标用户并输入名称生成头像融合动图；<code>{prefix}eatgif clear</code> 清理缓存。"},
    ],
    async handle(invocation, context) {
      const sub = invocation.args[0]?.toLowerCase() ?? "";
      try {
        if (!sub || sub === "help" || sub === "h") { await showList(invocation, context); return; }
        const current = await getCatalog(context);
        const selected = current[sub]; if (!selected) { await context.telegram.edit(invocation.message, `未找到：<code>${escape(sub)}</code>`, {parseMode: "html"}); return; }
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
            if (entry.you) overlays.push(await masked(sharp, relative=>asset(context,relative), entry.you, faces.you));
            if (entry.me) overlays.push(await masked(sharp, relative=>asset(context,relative), entry.me, faces.me));
            const canvas = await asset(context, entry.url);
            const metadata=await boundedSharp(sharp,canvas).metadata();
            if(metadata.width!==detail.width||metadata.height!==detail.height||metadata.width>512||metadata.height>512)throw new Error("Invalid frame dimensions");
            const data = await boundedSharp(sharp,canvas).composite(overlays).ensureAlpha().raw().toBuffer();
            frames.push({data, delay: Math.max(20, Math.min(5000, Number(entry.delay) || 100))});
          }
          const gif = path.join(directory, "output.gif"), webm = path.join(directory, "output.webm");
          const handle = await open(gif, "wx", 0o600); try { await handle.writeFile(Buffer.from(await encode({width: detail.width, height: detail.height, frames}))); } finally { await handle.close(); }
          await ffmpeg(context, ["-nostdin", "-y", "-protocol_whitelist", "file", "-i", gif, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "41", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-fs", String(MAX_OUTPUT_BYTES), webm], directory, signal);
          const output = await stat(webm); if (!output.size || output.size > MAX_OUTPUT_BYTES) throw new Error("Invalid output");
          await context.telegram.withClient(async client => { const {Api} = await import("teleproto");
            await client.sendFile(raw.peerId, {file: webm, replyTo: invocation.message.replyToId,
              attributes: [new Api.DocumentAttributeSticker({alt: "✨", stickerset: new Api.InputStickerSetEmpty()})]});
            if (typeof raw.delete === "function") { try { await raw.delete({revoke: true}); }
              catch { if (!context.signal.aborted) context.log.info("eatgif_receipt_cleanup_failed"); } } });
        });
      } catch { if (context.signal.aborted) return; context.log.error("eatgif_failed");
        await context.telegram.edit(invocation.message, "动图生成失败，请确认头像、远程素材、Sharp 与 FFmpeg 均可用"); }
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "eatgif", description: "将双方头像合成为动画贴纸",
    resources: {processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 180_000, maxOutputBytes: 256 * 1024}},
    renderHelp: prefix => renderCommandHelp("eatgif", eatgifCommand, {prefix, title: "🧩 头像动图表情"}),
    commands: {eatgif: eatgifCommand}, cleanup() { catalog = undefined; cacheTail=Promise.resolve(); },
  });
}
