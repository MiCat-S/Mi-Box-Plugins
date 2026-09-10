import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin, type PluginContext} from "telebox/sdk";
import {CustomFile} from "teleproto/client/uploads";
const api = "https://api.txqq.pro/api/zt.php";
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
export default function createJupai() {
  const command: CommandDefinition = {
    args: "[文本]", arguments: [{name: "文本", description: "省略时读取回复消息；最多 500 字符"}],
    examples: [{args: "你好世界"}, {args: "", description: "回复消息后生成举牌小人"}],
    help: [{heading: "说明：", body: "将文本发送至 api.txqq.pro 生成图片，单张最多 5 MiB。"}],
    description: "生成举牌小人图片", async handle(invocation, ctx: PluginContext) {
      let text = invocation.args.join(" ").trim();
      if (!text) {
        const reply = await ctx.telegram.getReply(invocation.message);
        text = reply?.text?.trim() ?? "";
      }
      if (!text) { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode:"html"}); return; }
      if (text.length > 500) { await ctx.telegram.edit(invocation.message, "文本过长，最多支持 500 字符"); return; }
      try {
        await ctx.telegram.edit(invocation.message, "正在生成举牌小人…");
        const image = await ctx.http.withResponse(`${api}?msg=${encodeURIComponent(text)}`, {}, async (response, signal) => {
          if (response.status !== 200 || !response.body) throw new Error("图片服务不可用");
          const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
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
              if (total > 5 * 1024 * 1024) throw new Error("图片过大");
              chunks.push(part.value);
            }
            if (!total) throw new Error("图片为空");
            return Buffer.concat(chunks, total);
          } finally {
            signal.removeEventListener("abort", abort);
            try { if (!complete) await cancel(); } finally { reader.releaseLock(); }
          }
        }, {timeoutMs: 60000, redirects:{allowedHosts:["api.txqq.pro"],maxRedirects:2}});
        ctx.signal.throwIfAborted();
        await ctx.telegram.withClient(async (client, signal) => {
          signal.throwIfAborted();
          return client.sendFile(invocation.message.chatId, {
            file: new CustomFile("jupai.jpg", image.length, "", image),
            caption: text, replyTo: invocation.message.replyToId ?? invocation.message.id,
          });
        });
        await ctx.telegram.edit(invocation.message, "举牌小人已发送");
      } catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `生成失败，请稍后重试（${esc(text.slice(0, 80))}）`, {parseMode:"html"}); }
    }};
  const help = (prefix: string) => renderCommandHelp("jupai", command, {prefix, title: "举牌小人"});
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "jupai", description: "生成举牌小人图片", commands: {
    jupai: command,
  }});
}
