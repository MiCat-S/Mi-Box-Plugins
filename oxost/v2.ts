import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, ui, type MessageEnvelope, type PluginContext } from "telebox/sdk";
import type { Api } from "teleproto";
import { openAsBlob } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>\"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );

async function output(context: PluginContext, message: MessageEnvelope, source: string): Promise<void> {
  const rendered = await ui.renderRichText(source, ui.PAGE_LABEL_RESERVE);
  const pages = rendered.map((page, index) => page + ui.pageLabel(index, rendered.length));
  const result = await ui.deliverPages(pages, context.signal, (page, index) =>
    index
      ? context.telegram.reply(message, page, { parseMode: "html" })
      : context.telegram.edit(message, page, { parseMode: "html" }),
  );
  if (!result.interrupted) return;
  context.log.info("oxost_pagination_interrupted", {
    published: result.published,
    total: result.total,
    category: ui.deliveryErrorCategory(result.error),
  });
  if (!result.published) throw result.error;
  try {
    await context.telegram.reply(message, ui.interruptedNotice(result), { parseMode: "html" });
  } catch {}
}

function announcedTooLarge(value: unknown): boolean {
  if (value && typeof value === "object" && "greater" in value && typeof value.greater === "function") {
    return value.greater(MAX_UPLOAD_BYTES);
  }
  if (typeof value === "bigint") return value > BigInt(MAX_UPLOAD_BYTES);
  return typeof value === "number" && Number.isFinite(value) && value > MAX_UPLOAD_BYTES;
}

function uploadName(raw: Api.Message, data: Buffer): string {
  const document = raw.document as { attributes?: unknown[] } | undefined;
  for (const attribute of document?.attributes ?? []) {
    const name = (attribute as { fileName?: unknown }).fileName;
    if (typeof name === "string" && name) return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file.bin";
  }
  if (raw.message) return raw.message.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32) || "file.bin";
  if (raw.video) return "video.mp4";
  if (raw.audio || raw.voice) return raw.voice ? "voice.ogg" : "audio.ogg";
  if (raw.photo) {
    const head = data.subarray(0, 12).toString("hex").toLowerCase();
    if (head.startsWith("ffd8ff")) return "photo.jpg";
    if (head.startsWith("89504e47")) return "photo.png";
    if (head.startsWith("47494638")) return "photo.gif";
    if (head.startsWith("52494646") && head.slice(16, 24) === "57454250") return "photo.webp";
  }
  return "file.bin";
}

function resultUrl(text: string): string {
  const url = new URL(text.trim());
  if (url.protocol !== "https:" || url.hostname !== "0x0.st" || url.username || url.password)
    throw new Error("Invalid URL");
  return url.href;
}

export default function createOxost() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "oxost",
    description: "上传回复中的媒体到 0x0.st",
    commands: {
      "0x0": {
        helpArgs: ["help", "h"],
        description: "上传回复中的媒体到 0x0.st",
        async handle(invocation, context) {
          if (invocation.args.some(value => ["help", "h"].includes(value.toLowerCase()))) {
            await output(context, invocation.message, renderPluginHelp(invocation.prefix));
            return;
          }
          const unknown = invocation.args.find(value => value !== "secret" && !/^expires=\d+$/.test(value));
          const expiry = invocation.args.map(value => /^expires=(\d+)$/.exec(value)?.[1]).find(Boolean);
          if (unknown || (expiry && (Number(expiry) < 1 || Number(expiry) > 8760))) {
            await output(context, invocation.message, renderPluginHelp(invocation.prefix));
            return;
          }
          if (invocation.message.replyToId === undefined) {
            await context.telegram.edit(invocation.message, "<b>上传失败</b>\n请回复带文件、图片、视频或音频的消息", {
              parseMode: "html",
            });
            return;
          }
          try {
            const reply = await context.telegram.getReply(invocation.message);
            context.signal.throwIfAborted();
            const raw = reply?.raw as Api.Message | undefined;
            if (!raw?.media || typeof raw.downloadMedia !== "function") throw new Error("No media");
            if (announcedTooLarge(raw.document?.size)) throw new Error("Media too large");
            await context.telegram.edit(invocation.message, "正在下载并上传…");
            context.signal.throwIfAborted();
            let uploadedUrl: string | undefined;
            try {
              await context.files.withTemp(async (directory, tempSignal) => {
                const file = path.join(directory, "upload.bin");
                await context.telegram.withClient(async (_client, clientSignal) => {
                  const signal = AbortSignal.any([context.signal, tempSignal, clientSignal]);
                  await raw.downloadMedia({
                    outputFile: file,
                    signal,
                    progressCallback(downloaded) {
                      signal.throwIfAborted();
                      if (downloaded.greater(MAX_UPLOAD_BYTES)) throw new Error("Media too large");
                    },
                  });
                  signal.throwIfAborted();
                });
                const info = await stat(file);
                tempSignal.throwIfAborted();
                if (!info.isFile() || info.size === 0 || info.size > MAX_UPLOAD_BYTES) throw new Error("Invalid media");
                const header = Buffer.alloc(12);
                const handle = await open(file, "r");
                try {
                  await handle.read(header, 0, header.length, 0);
                  tempSignal.throwIfAborted();
                } finally {
                  await handle.close();
                }
                tempSignal.throwIfAborted();
                const form = new FormData();
                form.append(
                  "file",
                  await openAsBlob(file, { type: "application/octet-stream" }),
                  uploadName(raw, header),
                );
                tempSignal.throwIfAborted();
                if (expiry) form.append("expires", expiry);
                if (invocation.args.includes("secret")) form.append("secret", "1");
                const response = await context.http.text(
                  "https://0x0.st",
                  {
                    method: "POST",
                    body: form,
                    redirect: "manual",
                    credentials: "omit",
                    headers: { "User-Agent": "MiBot-Oxost/2.0" },
                  },
                  {
                    timeoutMs: 60_000,
                    signal: AbortSignal.any([context.signal, tempSignal]),
                    redirects: { allowedHosts: ["0x0.st"], maxRedirects: 2 },
                  },
                );
                tempSignal.throwIfAborted();
                uploadedUrl = resultUrl(response);
              });
            } catch (error) {
              context.signal.throwIfAborted();
              if (!uploadedUrl) throw error;
              context.log.info("oxost_temp_cleanup_failed");
            }
            context.signal.throwIfAborted();
            await output(context, invocation.message, `<code>${escape(uploadedUrl!)}</code>`);
          } catch {
            if (context.signal.aborted) return;
            context.log.error("oxost_upload_failed");
            await context.telegram.edit(invocation.message, "<b>上传失败</b>\n请检查回复媒体并稍后重试", {
              parseMode: "html",
            });
          }
        },
      },
    },
  });
}
