import {access, stat} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const COMMANDS = ["/usr/bin/magick", "/usr/bin/convert", "/usr/local/bin/magick", "/opt/homebrew/bin/magick"] as const;

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

async function imageMagick(context: PluginContext, args: readonly string[]) {
  for (const command of COMMANDS) {
    try { return {command, result: await context.processes.run(command, args, {timeoutMs: 60_000, maxOutputBytes: 256 * 1024})}; }
    catch (error) {
      context.signal.throwIfAborted();
      if ((error as {code?: unknown})?.code !== "SPAWN_FAILED") throw error;
      try { await access(command, constants.F_OK); } catch { continue; }
      throw error;
    }
  }
  throw new Error("ImageMagick unavailable");
}

function help(prefix: string): string {
  return `<b>贴纸转图片</b>\n回复贴纸后发送：\n` +
    `<code>${escape(prefix)}stp</code> JPG 白底\n<code>${escape(prefix)}stp png</code> PNG 白底\n` +
    `<code>${escape(prefix)}stp transparent</code> PNG 透明背景\n<code>${escape(prefix)}stp doc [png] [transparent]</code> 文档发送\n` +
    `<code>${escape(prefix)}stp check</code> 检查 ImageMagick`;
}

function options(args: readonly string[]): {format: "jpg" | "png"; transparent: boolean; document: boolean} | undefined {
  if (!args.length) return {format: "jpg", transparent: false, document: false};
  const values = new Set(args.map(value => value.toLowerCase()));
  if ([...values].some(value => !["jpg", "png", "transparent", "doc"].includes(value))) return;
  const transparent = values.has("transparent");
  return {format: transparent || values.has("png") ? "png" : "jpg", transparent, document: values.has("doc")};
}

export default function createStickerToPic() {
  const command = {description: "将回复的静态贴纸转换为图片", async handle(invocation: any, context: PluginContext) {
    const sub = invocation.args[0]?.toLowerCase();
    if (sub === "help" || sub === "h") { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    if (sub === "check") {
      try {
        const {command, result} = await imageMagick(context, ["-version"]);
        const version = result.stdout.toString("utf8").split(/\r?\n/)[0]?.slice(0, 300) || "可执行";
        await context.telegram.edit(invocation.message, `<b>ImageMagick 可用</b>\n<code>${escape(command)}</code>\n<code>${escape(version)}</code>`, {parseMode: "html"});
      } catch { if (!context.signal.aborted) await context.telegram.edit(invocation.message, "未检测到 ImageMagick，请先由管理员安装 imagemagick"); }
      return;
    }
    const selected = options(invocation.args);
    if (!selected) { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    if (invocation.message.replyToId === undefined) { await context.telegram.edit(invocation.message, "请回复一个静态贴纸"); return; }
    try {
      const reply = await context.telegram.getReply(invocation.message);
      const source = reply?.raw as ApiTypes.Message | undefined;
      if (!source) { await context.telegram.edit(invocation.message, "请回复一个静态贴纸"); return; }
      const {Api} = await import("teleproto");
      const document: any = source?.document;
      if (!(document instanceof Api.Document) || !(document.attributes ?? []).some((value: any) => value instanceof Api.DocumentAttributeSticker)) {
        await context.telegram.edit(invocation.message, "请回复一个静态贴纸"); return;
      }
      if (document.mimeType && document.mimeType !== "image/webp") {
        await context.telegram.edit(invocation.message, "目前仅支持 WebP 静态贴纸"); return;
      }
      const sourceMessage = source;
      await context.telegram.edit(invocation.message, "正在转换贴纸…");
      await context.files.withTemp(async (directory, signal) => {
        const input = path.join(directory, "sticker.webp");
        const output = path.join(directory, `sticker.${selected.format}`);
        await context.telegram.withClient(async client => { await client.downloadMedia(sourceMessage.media!, {outputFile: input}); });
        signal.throwIfAborted();
        const flatten = selected.transparent ? [] : ["-background", "white", "-alpha", "remove", "-alpha", "off"];
        await imageMagick(context, [input, ...flatten, output]);
        const info = await stat(output);
        if (!info.isFile() || !info.size || info.size > 20 * 1024 * 1024) throw new Error("Invalid output");
        await context.telegram.withClient(async client => {
          const raw = invocation.message.raw as ApiTypes.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          await client.sendFile(raw.peerId, {file: output, replyTo: invocation.message.replyToId,
            forceDocument: selected.document, caption: `贴纸已转换为 ${selected.format.toUpperCase()}${selected.transparent ? "（透明背景）" : ""}`});
          if (typeof raw.delete === "function") await raw.delete({revoke: true});
        });
      });
    } catch {
      if (context.signal.aborted) return;
      context.log.error("sticker_to_pic_failed");
      await context.telegram.edit(invocation.message, "贴纸转换失败，请确认服务器已安装 ImageMagick 且回复的是静态贴纸");
    }
  }};
  return definePlugin({apiVersion: 1, id: "sticker_to_pic", description: "将静态贴纸转换为 JPG 或 PNG",
    resources: {processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 60_000, maxOutputBytes: 256 * 1024}},
    commands: {sticker_to_pic: command, stp: command}});
}
