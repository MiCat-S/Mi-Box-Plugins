import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin} from "telebox/sdk";
import type {Api} from "teleproto";
import {openAsBlob} from "node:fs";
import {open} from "node:fs/promises";
import path from "node:path";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);
const help = (prefix: string) => `<b>以图搜图</b>\n回复一张图片后发送 <code>${escape(prefix)}soutu</code>。\n图片会临时上传至 0x0.st，并生成 Google Lens 与 Yandex 链接。`;

function fileName(buffer: Buffer): string {
  const head = buffer.subarray(0, 12).toString("hex").toLowerCase();
  if (head.startsWith("89504e47")) return "photo.png";
  if (head.startsWith("47494638")) return "photo.gif";
  if (head.startsWith("52494646") && head.slice(16, 24) === "57454250") return "photo.webp";
  return "photo.jpg";
}

function validUploadUrl(value: string): URL {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.hostname !== "0x0.st" || url.username || url.password) throw new Error("Invalid upload URL");
  return url;
}

export default function createSoutu() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "soutu", description: "回复图片生成反向搜图链接",
    commands: {soutu: {helpArgs: ["help","h"], description: "回复图片生成反向搜图链接", async handle(invocation, context) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
        await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
        return;
      }
      if (invocation.message.replyToId === undefined) {
        await context.telegram.edit(invocation.message, "<b>搜图失败</b>\n请先回复一张图片", {parseMode: "html"});
        return;
      }
      try {
        const reply = await context.telegram.getReply(invocation.message);
        const raw = reply?.raw as Api.Message | undefined;
        if (!raw?.photo || typeof raw.downloadMedia !== "function") throw new Error("No photo");
        await context.telegram.edit(invocation.message, "正在下载并上传图片…");
        const uploaded = await context.files.withTemp(async (directory, signal) => {
          const target = path.join(directory, "photo.img");
          await context.telegram.withClient(async () => raw.downloadMedia({outputFile: target, signal,
            progressCallback: async received => {
              signal.throwIfAborted();
              if (BigInt(received.toString()) > 20n * 1024n * 1024n) throw new Error("Invalid image");
            },
          }));
          signal.throwIfAborted();
          const file = await open(target, "r");
          const header = Buffer.alloc(12);
          let read = 0;
          try {
            const {size} = await file.stat();
            if (size === 0 || size > 20 * 1024 * 1024) throw new Error("Invalid image");
            while (read < header.length) {
              const {bytesRead} = await file.read(header, read, header.length - read, read);
              if (!bytesRead) break;
              read += bytesRead;
            }
          } finally { await file.close(); }
          signal.throwIfAborted();
          const form = new FormData();
          form.append("file", await openAsBlob(target), fileName(header.subarray(0, read)));
          return context.http.text("https://0x0.st", {
            method: "POST", body: form, redirect: "manual", credentials: "omit",
            headers: {"User-Agent": "MiBot-Soutu/2.0"},
          }, {timeoutMs: 60_000, signal, redirects:{allowedHosts:["0x0.st"],maxRedirects:2}});
        });
        const image = validUploadUrl(uploaded);
        const source = escape(image.href);
        const google = escape(`https://lens.google.com/uploadbyurl?url=${encodeURIComponent(image.href)}`);
        const yandex = escape(`https://yandex.ru/images/search?url=${encodeURIComponent(image.href)}&rpt=imageview`);
        await context.telegram.edit(invocation.message,
          `<b>搜图结果</b>\n<a href="${source}">临时原图</a> · 约 30 天有效\n\n<a href="${google}">Google Lens</a>\n<a href="${yandex}">Yandex Images</a>`,
          {parseMode: "html", linkPreview: false});
      } catch {
        if (context.signal.aborted) return;
        context.log.error("soutu_search_failed");
        await context.telegram.edit(invocation.message, "<b>搜图失败</b>\n请确认回复的是图片并稍后重试", {parseMode: "html"});
      }
    }}},
  });
}
