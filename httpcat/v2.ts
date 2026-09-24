import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, type PluginContext } from "telebox/sdk";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function readImage(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (response.status !== 200 || !response.body) throw new Error("图片暂时不可用");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelling: Promise<void> | undefined;
  const cancel = () => (cancelling ??= reader.cancel().catch(() => undefined));
  const onAbort = () => {
    void cancel();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new Error("图片超过大小限制");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    signal.removeEventListener("abort", onAbort);
    await cancel();
    reader.releaseLock();
  }
}

export default function createHttpcat() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "httpcat",
    description: "发送 HTTP 状态码对应的图片",
    commands: {
      httpcat: {
        description: "发送 HTTP 状态码图片",
        async handle(invocation, ctx) {
          const code = invocation.args[0] ?? "";
          if (!/^\d{3}$/.test(code)) {
            await ctx.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), { parseMode: "html" });
            return;
          }
          try {
            await ctx.telegram.edit(invocation.message, `正在获取 HTTP ${code} 猫猫图片...`);
            const data = await ctx.http.withResponse(
              `https://http.cat/${code}`,
              {
                method: "GET",
                redirect: "manual",
                credentials: "omit",
                headers: { Accept: "image/jpeg", "User-Agent": "Mi-Box-Httpcat/1.0" },
              },
              (response, signal) => readImage(response, signal),
              { timeoutMs: 60_000, signal: ctx.signal, redirects: { allowedHosts: ["http.cat"], maxRedirects: 2 } },
            );
            ctx.signal.throwIfAborted();
            if (data.length === 0) {
              await ctx.telegram.edit(invocation.message, "图片获取失败或为空");
              return;
            }
            await ctx.telegram.withClient(async (client, signal) => {
              signal.throwIfAborted();
              const { CustomFile } = await import("teleproto/client/uploads.js");
              signal.throwIfAborted();
              const raw = invocation.message.raw as
                { peerId?: unknown; delete?: (options?: { revoke?: boolean }) => Promise<unknown> } | undefined;
              if (!raw?.peerId) throw new Error("当前会话不可发送文件");
              const file = new CustomFile(`httpcat_${code}.jpg`, data.length, "", data);
              await client.sendFile(raw.peerId as never, { file, replyTo: invocation.message.id });
              signal.throwIfAborted();
              if (typeof raw.delete === "function") {
                try {
                  await raw.delete({ revoke: true });
                } catch {
                  ctx.log.error("httpcat.delete_failed");
                }
              }
            });
          } catch {
            if (!ctx.signal.aborted) {
              ctx.log.error("httpcat.failed");
              await ctx.telegram.edit(invocation.message, "图片获取或发送失败，请稍后重试");
            }
          }
        },
      },
    },
  });
}
