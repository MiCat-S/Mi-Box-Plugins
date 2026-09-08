import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext} from "telebox/sdk";
import {setTimeout as delay} from "node:timers/promises";
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
const help = `<b>儒雅随和语录</b>\n<code>diss</code> 获取一条语录`;
async function readQuote(response: Response, signal: AbortSignal): Promise<string> {
  if (response.status !== 200 || !response.body) throw new Error("语录服务不可用");
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
      if (total > 16 * 1024) throw new Error("语录响应过大");
      chunks.push(part.value);
    }
    const text = new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks, total)).trim();
    if (!text || text.length > 4000) throw new Error("语录内容无效");
    return text;
  } finally {
    signal.removeEventListener("abort", abort);
    try {if (!complete) await cancel();} finally {reader.releaseLock();}
  }
}
export default function createDiss() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "diss", description: "获取儒雅随和语录", commands: {
    diss: {helpArgs: ["help","h"], description: "获取一条语录", async handle(invocation, ctx: PluginContext) {
      if (invocation.args[0] === "help" || invocation.args[0] === "h") { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
      try {
        await ctx.telegram.edit(invocation.message, "正在获取语录…");
        let text: string | undefined;
        for (let attempt = 0; attempt < 5; attempt++) {
          ctx.signal.throwIfAborted();
          try {
            text = await ctx.http.withResponse("https://api.oddfar.com/yl/q.php?c=1009&encode=text",
              {headers: {"user-agent": "Mi Box"}}, readQuote, {timeoutMs: 10000, redirects:{allowedHosts:["api.oddfar.com"],maxRedirects:2}});
            break;
          } catch {
            ctx.signal.throwIfAborted();
            if (attempt < 4) await delay(1000, undefined, {signal: ctx.signal});
          }
        }
        ctx.signal.throwIfAborted();
        if (!text) throw new Error("语录服务不可用");
        await ctx.telegram.edit(invocation.message, esc(text), {parseMode:"html", linkPreview: false});
      } catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "语录获取失败，请稍后重试"); }
    }},
  }});
}
