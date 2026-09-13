import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin} from "telebox/sdk";
import {CustomFile} from "teleproto/client/uploads";

const url = "https://api.52vmy.cn/api/wl/moyu";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_777_216;
type ReadResult = {done: boolean; value?: Uint8Array};

function readPart(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal, cancel: () => Promise<void>): Promise<ReadResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { void cancel(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, {once: true});
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function body(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (response.status !== 200 || !response.body) throw new Error("图片服务不可用");
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("图片过大");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = () => cancellation ??= reader.cancel().then(() => undefined, () => undefined);
  const abort = () => { void cancel(); };
  signal.addEventListener("abort", abort, {once: true});
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await readPart(reader, signal, cancel);
      signal.throwIfAborted();
      if (part.done) break;
      if (!part.value) continue;
      total += part.value.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new Error("图片过大");
      chunks.push(part.value);
    }
    if (!total) throw new Error("图片为空");
    return Buffer.concat(chunks, total);
  } finally {
    signal.removeEventListener("abort", abort);
    try { await cancel(); } finally { reader.releaseLock(); }
  }
}

async function validateImage(image: Buffer, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const sharp = (await import("sharp")).default;
  signal.throwIfAborted();
  const metadata = await sharp(image, {limitInputPixels: MAX_IMAGE_PIXELS, animated: false, pages: 1}).metadata();
  signal.throwIfAborted();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw new Error("图片像素超限");
}
export default function createMoyu() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "moyu", description: "获取摸鱼日报", commands: {
    moyu: {description: "获取摸鱼日报", async handle(invocation, ctx) {
      if (invocation.args.length) { await ctx.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), {parseMode:"html"}); return; }
      let sent = false;
      try {
        await ctx.telegram.edit(invocation.message, "开摸...");
        const image = await ctx.http.withResponse(url, {method: "GET", redirect: "manual", credentials: "omit", headers: {Accept: "image/*"}}, body,
          {timeoutMs: 15000, signal: ctx.signal, redirects:{allowedHosts:["api.52vmy.cn"],maxRedirects:2}});
        await validateImage(image, ctx.signal);
        ctx.signal.throwIfAborted();
        let deleteFailed = false;
        await ctx.telegram.withClient(async (client, signal) => {
          signal.throwIfAborted();
          const raw = invocation.message.raw as {peerId?: unknown} | undefined;
          if (!raw?.peerId) throw new Error("当前会话不可发送文件");
          const peer = raw.peerId as Parameters<typeof client.sendFile>[0];
          await client.sendFile(peer, {
            file: new CustomFile("moyu.jpg", image.length, "", image),
            caption: `摸鱼日报 ${new Date().toLocaleString("zh-CN", {timeZone:"Asia/Shanghai"})}`,
            forceDocument: false,
            replyTo: invocation.message.replyToId ?? invocation.message.topicId,
          });
          sent = true;
          signal.throwIfAborted();
          try { await client.deleteMessages(peer, [invocation.message.id], {revoke: true}); }
          catch {
            signal.throwIfAborted();
            deleteFailed = true;
            ctx.log.error("moyu_delete_failed");
          }
        });
        if (deleteFailed) await ctx.telegram.edit(invocation.message, "摸鱼日报已发送，命令消息删除失败");
      } catch {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message,
          sent ? "摸鱼日报已发送，命令消息删除失败" : "❌ 获取摸鱼日报失败，请稍后重试");
      }
    }},
  }});
}
