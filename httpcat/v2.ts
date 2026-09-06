import {definePlugin, type PluginContext} from "telebox/sdk";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const help = (prefix: string) => `<b>HTTP 猫猫图片</b>\n<code>${prefix}httpcat 404</code>\n支持 100–599 状态码。`;

async function readImage(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (response.status !== 200 || !response.body) throw new Error("图片暂时不可用");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new Error("图片超过大小限制");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export default function createHttpcat() {
  return definePlugin({apiVersion: 1, id: "httpcat", description: "发送 HTTP 状态码对应的图片",
    commands: {httpcat: {description: "发送 HTTP 状态码图片", async handle(invocation, ctx) {
      const code = invocation.args[0] ?? "";
      if (!/^[1-5]\d{2}$/.test(code)) {
        await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
        return;
      }
      try {
        await ctx.telegram.edit(invocation.message, `正在获取 HTTP ${code} 图片…`);
        const data = await ctx.http.withResponse(`https://http.cat/${code}.jpg`, {
          method: "GET", redirect: "manual", credentials: "omit",
          headers: {"Accept": "image/jpeg", "User-Agent": "Mi-Box-Httpcat/1.0"},
        }, (response, signal) => readImage(response, signal), {timeoutMs: 15_000, signal: ctx.signal});
        ctx.signal.throwIfAborted();
        await ctx.telegram.withClient(async client => {
          const {CustomFile} = await import("teleproto/client/uploads.js");
          const raw = invocation.message.raw as {peerId?: unknown} | undefined;
          if (!raw?.peerId) throw new Error("当前会话不可发送文件");
          const file = new CustomFile(`httpcat_${code}.jpg`, data.length, "", data);
          await client.sendFile(raw.peerId as never, {file, replyTo: invocation.message.id});
        });
        await ctx.telegram.edit(invocation.message, `HTTP ${code} 图片已发送`);
      } catch {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "图片获取或发送失败，请稍后重试");
      }
    }}},
  });
}
