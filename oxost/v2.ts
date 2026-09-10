import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin} from "telebox/sdk";
import type {Api} from "teleproto";
import {openAsBlob} from "node:fs";
import {open, stat} from "node:fs/promises";
import path from "node:path";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function uploadName(raw: Api.Message, data: Buffer): string {
  const document = raw.document as {attributes?: unknown[]} | undefined;
  for (const attribute of document?.attributes ?? []) {
    const name = (attribute as {fileName?: unknown}).fileName;
    if (typeof name === "string" && name) return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file.bin";
  }
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
  if (url.protocol !== "https:" || url.hostname !== "0x0.st" || url.username || url.password) throw new Error("Invalid URL");
  return url.href;
}

export default function createOxost() {
  const command: CommandDefinition = {
    args: "[expires=小时] [secret]", arguments: [{name: "expires=小时", description: "有效期，范围 1–8760 小时"}, {name: "secret", description: "生成更难猜的链接"}],
    examples: [{args: "", description: "回复文件、图片、视频或音频后上传"}, {args: "expires=72 secret"}],
    help: [{heading: "说明：", body: "将回复消息中的媒体上传至 <a href='https://0x0.st/'>0x0.st</a> 并返回下载链接，单个文件上限 100 MiB。"}],
    helpArgs: ["help","h"], description: "上传回复中的媒体到 0x0.st", async handle(invocation, context) {
      if (invocation.args.some(value => ["help", "h"].includes(value.toLowerCase()))) {
        await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
        return;
      }
      const unknown = invocation.args.find(value => value !== "secret" && !/^expires=\d+$/.test(value));
      const expiry = invocation.args.map(value => /^expires=(\d+)$/.exec(value)?.[1]).find(Boolean);
      if (unknown || (expiry && (Number(expiry) < 1 || Number(expiry) > 8760))) {
        await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
        return;
      }
      if (invocation.message.replyToId === undefined) {
        await context.telegram.edit(invocation.message, "<b>上传失败</b>\n请回复带文件、图片、视频或音频的消息", {parseMode: "html"});
        return;
      }
      try {
        const reply = await context.telegram.getReply(invocation.message);
        const raw = reply?.raw as Api.Message | undefined;
        if (!raw?.media || typeof raw.downloadMedia !== "function") throw new Error("No media");
        if (Number(raw.document?.size) > MAX_UPLOAD_BYTES) throw new Error("Media too large");
        await context.telegram.edit(invocation.message, "正在下载并上传…");
        const response = await context.files.withTemp(async directory => {
          const file = path.join(directory, "upload.bin");
          await context.telegram.withClient(async (_client, signal) => {
            await raw.downloadMedia({outputFile: file, signal, progressCallback(downloaded) {
              signal.throwIfAborted();
              if (downloaded.greater(MAX_UPLOAD_BYTES)) throw new Error("Media too large");
            }});
            signal.throwIfAborted();
          });
          const info = await stat(file);
          if (!info.isFile() || info.size === 0 || info.size > MAX_UPLOAD_BYTES) throw new Error("Invalid media");
          const header = Buffer.alloc(12);
          const handle = await open(file, "r");
          try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
          const form = new FormData();
          form.append("file", await openAsBlob(file, {type: "application/octet-stream"}), uploadName(raw, header));
          if (expiry) form.append("expires", expiry);
          if (invocation.args.includes("secret")) form.append("secret", "1");
          return context.http.text("https://0x0.st", {
            method: "POST", body: form, redirect: "manual", credentials: "omit",
            headers: {"User-Agent": "MiBot-Oxost/2.0"},
          }, {timeoutMs: 60_000, signal: context.signal, redirects:{allowedHosts:["0x0.st"],maxRedirects:2}});
        });
        await context.telegram.edit(invocation.message, `<code>${escape(resultUrl(response))}</code>`, {parseMode: "html"});
      } catch {
        if (context.signal.aborted) return;
        context.log.error("oxost_upload_failed");
        await context.telegram.edit(invocation.message, "<b>上传失败</b>\n请检查回复媒体并稍后重试", {parseMode: "html"});
      }
    }};
  const help = (prefix: string) => renderCommandHelp("0x0", command, {prefix, title: "🗂️ 0x0.st 文件上传"});
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "oxost", description: "上传回复中的媒体到 0x0.st",
    commands: {"0x0": command},
  });
}
