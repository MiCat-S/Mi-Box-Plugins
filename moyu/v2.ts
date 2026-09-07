import {definePlugin} from "telebox/sdk";
import {CustomFile} from "teleproto/client/uploads";

const url = "https://api.52vmy.cn/api/wl/moyu";
const help = `<b>摸鱼日报</b>\n<code>moyu</code> 获取今日摸鱼日报`;
async function body(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (response.status !== 200 || !response.body) throw new Error("图片服务不可用");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  let cancellation: Promise<void> | undefined;
  const cancel = () => cancellation ??= reader.cancel();
  const abort = () => { void cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, {once: true});
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) {complete = true; break;}
      total += part.value.byteLength;
      if (total > 8 * 1024 * 1024) throw new Error("图片过大");
      chunks.push(part.value);
    }
    if (!total) throw new Error("图片为空");
    return Buffer.concat(chunks, total);
  } finally {
    signal.removeEventListener("abort", abort);
    try { if (!complete) await cancel(); } finally { reader.releaseLock(); }
  }
}
export default function createMoyu() {
  return definePlugin({apiVersion: 1, id: "moyu", description: "获取摸鱼日报", commands: {
    moyu: {description: "获取摸鱼日报", async handle(invocation, ctx) {
      if (invocation.args.length) { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
      let sent = false;
      try {
        await ctx.telegram.edit(invocation.message, "开摸…");
        const image = await ctx.http.withResponse(url, {}, body, {timeoutMs: 15000, redirects:{allowedHosts:["api.52vmy.cn"],maxRedirects:2}});
        ctx.signal.throwIfAborted();
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
          await client.deleteMessages(peer, [invocation.message.id], {revoke: true});
        });
      } catch {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message,
          sent ? "摸鱼日报已发送，命令消息删除失败" : "获取摸鱼日报失败，请稍后重试");
      }
    }},
  }});
}
