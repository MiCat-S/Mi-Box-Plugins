import {stat} from "node:fs/promises";
import path from "node:path";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

type Config = {schemaVersion: number; defaultEmoji: string; quality: number; format: "webp" | "png";
  size: number; background: "transparent" | "white" | "black"; autoDelete: boolean; compressionLevel: number};
const defaults: Config = {schemaVersion: 1, defaultEmoji: "🙂", quality: 90, format: "webp", size: 512,
  background: "transparent", autoDelete: true, compressionLevel: 6};

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;"})[character]!);

function normalize(value: Record<string, unknown>): Config {
  const integer = (entry: unknown, fallback: number, min: number, max: number) =>
    Number.isInteger(entry) && Number(entry) >= min && Number(entry) <= max ? Number(entry) : fallback;
  return {...value, schemaVersion: 1,
    defaultEmoji: typeof value.defaultEmoji === "string" && value.defaultEmoji.trim() ? value.defaultEmoji.slice(0, 32) : defaults.defaultEmoji,
    quality: integer(value.quality, defaults.quality, 1, 100), format: value.format === "png" ? "png" : "webp",
    size: integer(value.size, defaults.size, 256, 512),
    background: ["transparent", "white", "black"].includes(String(value.background)) ? value.background as Config["background"] : defaults.background,
    autoDelete: typeof value.autoDelete === "boolean" ? value.autoDelete : defaults.autoDelete,
    compressionLevel: integer(value.compressionLevel, defaults.compressionLevel, 0, 9)} as Config;
}

async function configuration(context: PluginContext) {
  const store = context.storage.json("config.json", defaults);
  let current = normalize(await store.read());
  current = await store.update(value => normalize(value));
  return {store, current};
}

function help(prefix: string): string { return `<b>图片转贴纸</b>\n回复图片：<code>${escape(prefix)}pts [表情]</code>\n` +
  `<code>${escape(prefix)}pts batch</code> 批量转换\n<code>${escape(prefix)}pts config [emoji|size|quality|bg|auto] 值</code>`; }

function background(value: Config["background"]) {
  return value === "white" ? {r: 255, g: 255, b: 255, alpha: 1} : value === "black" ?
    {r: 0, g: 0, b: 0, alpha: 1} : {r: 0, g: 0, b: 0, alpha: 0};
}

async function convert(context: PluginContext, source: ApiTypes.Message, config: Config, emoji: string,
  send: (output: string) => Promise<void>): Promise<void> {
  if (!source.media) throw new Error("Photo required");
  await context.files.withTemp(async (directory, signal) => {
    const input = path.join(directory, "source-image");
    const output = path.join(directory, `sticker.${config.format}`);
    await context.telegram.withClient(client => client.downloadMedia(source.media!, {outputFile: input}));
    signal.throwIfAborted();
    const sharp = (await import("sharp")).default;
    const metadata = await sharp(input, {animated: true}).metadata();
    let operation = sharp(input, {animated: Boolean(metadata.pages && metadata.pages > 1)}).resize(config.size, config.size,
      {fit: "contain", background: background(config.background)});
    operation = config.format === "png" ? operation.png({compressionLevel: config.compressionLevel}) :
      operation.webp({quality: config.quality, effort: Math.min(6, config.compressionLevel)});
    await operation.toFile(output);
    let info = await stat(output);
    if (!info.isFile() || info.size === 0) throw new Error("Invalid output");
    if (info.size > 512 * 1024 && config.format === "webp") {
      await sharp(input, {animated: Boolean(metadata.pages && metadata.pages > 1)}).resize(config.size, config.size,
        {fit: "contain", background: background(config.background)}).webp({quality: Math.max(10, Math.floor(config.quality * 0.6)), effort: 6}).toFile(output);
      info = await stat(output);
    }
    if (info.size > 512 * 1024) throw new Error("Sticker too large");
    signal.throwIfAborted();
    await send(output);
  });
}

async function configure(invocation: any, context: PluginContext): Promise<void> {
  const args = invocation.args.slice(1); const option = args[0]?.toLowerCase(); const supplied = args[1];
  const {store, current} = await configuration(context);
  if (!option) {
    await context.telegram.edit(invocation.message, `<b>当前配置</b>\n默认表情：${escape(current.defaultEmoji)}\n尺寸：${current.size}\n` +
      `质量：${current.quality}\n格式：${current.format}\n背景：${current.background}\n自动删除：${current.autoDelete ? "开启" : "关闭"}`, {parseMode: "html"}); return;
  }
  const patch: Partial<Config> = {};
  if (option === "emoji" && supplied) patch.defaultEmoji = supplied.slice(0, 32);
  else if (option === "size" && Number.isInteger(Number(supplied)) && Number(supplied) >= 256 && Number(supplied) <= 512) patch.size = Number(supplied);
  else if (option === "quality" && Number.isInteger(Number(supplied)) && Number(supplied) >= 1 && Number(supplied) <= 100) patch.quality = Number(supplied);
  else if (["bg", "background"].includes(option) && ["transparent", "white", "black"].includes(supplied ?? "")) patch.background = supplied as Config["background"];
  else if (option === "auto" && ["on", "off"].includes(supplied ?? "")) patch.autoDelete = supplied === "on";
  else if (option === "format" && ["webp", "png"].includes(supplied ?? "")) patch.format = supplied as Config["format"];
  else { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
  await store.update(value => normalize({...value, ...patch}));
  await context.telegram.edit(invocation.message, "配置已保存");
}

export default function createPicToSticker() {
  const command = {description: "将回复的图片转换为 Telegram 贴纸", async handle(invocation: any, context: PluginContext) {
    const sub = invocation.args[0]?.toLowerCase();
    if (["help", "h"].includes(sub)) { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    if (sub === "config") { await configure(invocation, context); return; }
    if (invocation.message.replyToId === undefined) { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    try {
      const config = (await configuration(context)).current;
      const reply = await context.telegram.getReply(invocation.message);
      const source = reply?.raw as ApiTypes.Message | undefined;
      if (!source?.media) throw new Error("Photo required");
      const raw = invocation.message.raw as ApiTypes.Message | undefined;
      if (!raw?.peerId) throw new Error("Missing peer");
      const {Api} = await import("teleproto");
      const selected = sub === "batch" ? config.defaultEmoji : (invocation.args[0] || config.defaultEmoji).slice(0, 32);
      const candidates: ApiTypes.Message[] = [source];
      if (sub === "batch" && (source as any).groupedId) {
        const group = await context.telegram.withClient(client => client.getMessages(raw.peerId!, {limit: 20, offsetId: source.id}));
        for (const item of group as any[]) if (String(item?.groupedId ?? "") === String((source as any).groupedId) && item?.media && !candidates.some(value => value.id === item.id)) candidates.push(item);
      }
      let completed = 0;
      for (const item of candidates.slice(0, 20)) {
        await convert(context, item, config, selected, output => context.telegram.withClient(async client => {
          await client.sendFile(raw.peerId!, {file: output,
            attributes: [new Api.DocumentAttributeSticker({alt: selected, stickerset: new Api.InputStickerSetEmpty()})], replyTo: invocation.message.replyToId});
        }));
        completed++;
      }
      if (config.autoDelete && typeof raw.delete === "function") await raw.delete({revoke: true});
      else await context.telegram.edit(invocation.message, sub === "batch" ? `批量转换完成：${completed} 张` : `贴纸已发送 ${escape(selected)}`, {parseMode: "html"});
    } catch {
      if (context.signal.aborted) return;
      context.log.error("pic_to_sticker_failed");
      await context.telegram.edit(invocation.message, "图片转换失败，请确认回复的是图片、格式受支持且输出小于 512 KiB");
    }
  }};
  return definePlugin({apiVersion: 1, id: "pic_to_sticker", description: "将图片转换为贴纸", commands: {pic_to_sticker: command, pts: command},
    settings: context => ({title: "图片转贴纸", description: "贴纸转换配置", category: "插件配置", icon: "🖼️",
      getSchema: () => [{key: "defaultEmoji", label: "默认表情", type: "string", max: 32}, {key: "quality", label: "质量", type: "number", min: 1, max: 100},
        {key: "format", label: "格式", type: "select", options: [{value: "webp", label: "WebP"}, {value: "png", label: "PNG"}]},
        {key: "size", label: "尺寸", type: "number", min: 256, max: 512}, {key: "background", label: "背景", type: "select", options: [
          {value: "transparent", label: "透明"}, {value: "white", label: "白色"}, {value: "black", label: "黑色"}]},
        {key: "autoDelete", label: "自动删除命令", type: "boolean"}, {key: "compressionLevel", label: "压缩等级", type: "number", min: 0, max: 9}],
      async getValues() { return (await configuration(context)).current; },
      async setValues(patch) { await (await configuration(context)).store.update(value => normalize({...value, ...patch})); }}),
  });
}
