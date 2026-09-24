import { renderHelp as renderPluginHelp } from "./v2/help";
import { access, open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { definePlugin, type PluginContext } from "telebox/sdk";
import type { Api as ApiTypes } from "teleproto";

const COMMANDS = ["/usr/bin/magick", "/usr/bin/convert", "/usr/local/bin/magick", "/opt/homebrew/bin/magick"] as const;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>\"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );

async function imageMagick(context: PluginContext, args: readonly string[], cwd?: string) {
  for (const command of COMMANDS) {
    try {
      return {
        command,
        result: await context.processes.run(command, args, {
          timeoutMs: 60_000,
          maxOutputBytes: 256 * 1024,
          ...(cwd ? { cwd, env: { MAGICK_TEMPORARY_PATH: cwd } } : {}),
        }),
      };
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
  throw new Error("ImageMagick unavailable");
}

function help(prefix: string): string {
  return (
    `<b>贴纸转图片</b>\n回复贴纸后发送：\n` +
    `<code>${escape(prefix)}stp</code> JPG 白底\n<code>${escape(prefix)}stp png</code> PNG 白底\n` +
    `<code>${escape(prefix)}stp transparent</code> PNG 透明背景\n<code>${escape(prefix)}stp doc [png] [transparent]</code> 文档发送\n` +
    `<code>${escape(prefix)}stp check</code> 检查 ImageMagick`
  );
}

function options(
  args: readonly string[],
): { format: "jpg" | "png"; transparent: boolean; document: boolean } | undefined {
  if (!args.length) return { format: "jpg", transparent: false, document: false };
  const values = args.map(value => value.toLowerCase()),
    sub = values[0];
  if (sub === "png" && values.every(value => value === "png" || value === "transparent"))
    return { format: "png", transparent: values.includes("transparent"), document: false };
  if (sub === "transparent" && values.length === 1) return { format: "png", transparent: true, document: false };
  if (sub === "doc" && values.every(value => ["doc", "png", "transparent"].includes(value))) {
    const png = values.includes("png");
    return { format: png ? "png" : "jpg", transparent: png && values.includes("transparent"), document: true };
  }
  return;
}

async function download(context: PluginContext, media: unknown, target: string, signal: AbortSignal): Promise<void> {
  await context.telegram.withClient(async (client: any, clientSignal) => {
    const file = await open(target, "wx", 0o600);
    let size = 0;
    try {
      for await (const chunk of client.iterDownload(media, { signal: clientSignal })) {
        signal.throwIfAborted();
        clientSignal.throwIfAborted();
        size += chunk.length;
        if (size > MAX_MEDIA_BYTES) throw new Error("Sticker too large");
        let offset = 0;
        while (offset < chunk.length) {
          signal.throwIfAborted();
          const result = await file.write(chunk, offset, chunk.length - offset);
          signal.throwIfAborted();
          if (!result.bytesWritten) throw new Error("Sticker write failed");
          offset += result.bytesWritten;
        }
      }
      if (!size) throw new Error("Empty sticker");
    } finally {
      await file.close();
    }
  });
}

async function validateWebp(target: string, signal: AbortSignal): Promise<void> {
  const file = await open(target, "r");
  const header = Buffer.alloc(12);
  try {
    const result = await file.read(header, 0, header.length, 0);
    signal.throwIfAborted();
    if (
      result.bytesRead !== 12 ||
      header.toString("ascii", 0, 4) !== "RIFF" ||
      header.toString("ascii", 8, 12) !== "WEBP"
    )
      throw new Error("Invalid WebP");
  } finally {
    await file.close();
  }
}

async function withBusinessTemp(
  context: PluginContext,
  use: (directory: string, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  let completed = false;
  try {
    await context.files.withTemp(async (directory, signal) => {
      await use(directory, signal);
      completed = true;
    });
  } catch (error) {
    if (context.signal.aborted || !completed) throw error;
    context.log.error("sticker_to_pic_temp_cleanup_failed");
  }
}

export default function createStickerToPic() {
  const command = {
    description: "将回复的静态贴纸转换为图片",
    async handle(invocation: any, context: PluginContext) {
      const sub = invocation.args[0]?.toLowerCase();
      if (sub === "help" || sub === "h") {
        await context.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), { parseMode: "html" });
        return;
      }
      if (sub === "check") {
        try {
          const { command, result } = await imageMagick(context, ["-version"]);
          const version = result.stdout.toString("utf8").split(/\r?\n/)[0]?.slice(0, 300) || "可执行";
          await context.telegram.edit(
            invocation.message,
            `<b>ImageMagick 可用</b>\n<code>${escape(command)}</code>\n<code>${escape(version)}</code>`,
            { parseMode: "html" },
          );
        } catch {
          if (!context.signal.aborted)
            await context.telegram.edit(invocation.message, "未检测到 ImageMagick，请先由管理员安装 imagemagick");
        }
        return;
      }
      const selected = options(invocation.args);
      if (!selected) {
        await context.telegram.edit(
          invocation.message,
          `❌ <b>未知子命令:</b> <code>${escape(sub ?? "")}</code>\n\n请使用 <code>${escape(invocation.prefix)}stp help</code> 查看可用选项`,
          { parseMode: "html" },
        );
        return;
      }
      if (invocation.message.replyToId === undefined) {
        await context.telegram.edit(invocation.message, "请回复一个静态贴纸");
        return;
      }
      try {
        const reply = await context.telegram.getReply(invocation.message);
        const source = reply?.raw as ApiTypes.Message | undefined;
        if (!source) {
          await context.telegram.edit(invocation.message, "请回复一个静态贴纸");
          return;
        }
        const { Api } = await import("teleproto");
        const document: any = source?.document ?? (source as any)?.media?.document;
        if (
          !(document instanceof Api.Document) ||
          !(document.attributes ?? []).some((value: any) => value instanceof Api.DocumentAttributeSticker)
        ) {
          await context.telegram.edit(invocation.message, "请回复一个静态贴纸");
          return;
        }
        if (document.mimeType && document.mimeType !== "image/webp") {
          await context.telegram.edit(invocation.message, "目前仅支持 WebP 静态贴纸");
          return;
        }
        if (document.size != null) {
          let declared: bigint;
          try {
            declared = BigInt(document.size.toString());
          } catch {
            await context.telegram.edit(invocation.message, "贴纸文件大小无效");
            return;
          }
          if (declared <= 0n || declared > BigInt(MAX_MEDIA_BYTES)) {
            await context.telegram.edit(invocation.message, "贴纸文件不能超过 20 MiB");
            return;
          }
        }
        const sourceMessage = source;
        await context.telegram.edit(invocation.message, "📥 正在下载贴纸...", { parseMode: "html" });
        await withBusinessTemp(context, async (directory, signal) => {
          const input = path.join(directory, "sticker.webp");
          const output = path.join(directory, `sticker.${selected.format}`);
          await download(context, (sourceMessage as any).media, input, signal);
          await validateWebp(input, signal);
          signal.throwIfAborted();
          await context.telegram.edit(invocation.message, `🔄 正在转换为${selected.format.toUpperCase()}格式...`, {
            parseMode: "html",
          });
          const flatten = selected.transparent
            ? []
            : selected.format === "png"
              ? ["-background", "white", "-alpha", "remove"]
              : ["-background", "white", "-alpha", "remove", "-alpha", "off"];
          const limits = [
            "-limit",
            "width",
            "512",
            "-limit",
            "height",
            "512",
            "-limit",
            "memory",
            "64MiB",
            "-limit",
            "map",
            "128MiB",
            "-limit",
            "disk",
            "256MiB",
          ];
          await imageMagick(context, [...limits, `webp:${input}[0]`, ...flatten, output], directory);
          signal.throwIfAborted();
          const info = await stat(output);
          signal.throwIfAborted();
          if (!info.isFile() || !info.size || info.size > 20 * 1024 * 1024) throw new Error("Invalid output");
          await context.telegram.edit(invocation.message, "📤 正在发送图片...", { parseMode: "html" });
          let deleteFailed = false;
          await context.telegram.withClient(async (client, clientSignal) => {
            signal.throwIfAborted();
            clientSignal.throwIfAborted();
            const raw = invocation.message.raw as ApiTypes.Message | undefined;
            if (!raw?.peerId) throw new Error("Missing peer");
            await client.sendFile(raw.peerId, {
              file: output,
              replyTo: invocation.message.replyToId,
              forceDocument: selected.document,
              parseMode: "html",
              caption: `${selected.document ? "📄" : "🖼️"} <b>贴纸已转换为${selected.format.toUpperCase()}格式${selected.document ? "（原图）" : ""}</b>${selected.transparent ? "（透明背景）" : ""}`,
            });
            signal.throwIfAborted();
            clientSignal.throwIfAborted();
            try {
              await client.deleteMessages(raw.peerId, [invocation.message.id], { revoke: true });
            } catch {
              signal.throwIfAborted();
              clientSignal.throwIfAborted();
              deleteFailed = true;
              context.log.error("sticker_to_pic_delete_failed");
            }
          });
          if (deleteFailed)
            try {
              await context.telegram.edit(invocation.message, "图片已发送，命令消息删除失败");
            } catch {
              context.log.error("sticker_to_pic_receipt_failed");
            }
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("sticker_to_pic_failed");
        await context.telegram.edit(
          invocation.message,
          "贴纸转换失败，请确认服务器已安装 ImageMagick 且回复的是静态贴纸",
        );
      }
    },
  };
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "sticker_to_pic",
    description: "将静态贴纸转换为 JPG 或 PNG",
    resources: { processes: { concurrency: 1, queueCapacity: 2, timeoutMs: 60_000, maxOutputBytes: 256 * 1024 } },
    commands: { sticker_to_pic: { ...command, helpArgs: ["help", "h"] }, stp: { ...command, helpArgs: ["help", "h"] } },
  });
}
