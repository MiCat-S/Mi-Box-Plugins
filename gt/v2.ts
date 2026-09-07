import {definePlugin} from "telebox/sdk";

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const help = `📘 <b>Google 翻译</b>

• <code>gt [文本]</code> - 翻译为简体中文
• <code>gt en [文本]</code> - 翻译为英文
• 回复消息后使用 <code>gt</code> 或 <code>gt en</code>
• <code>gt help</code> - 查看帮助

使用 Google 自动识别原文语言，无需配置 API Key。
待翻译文本会发送至 Google 翻译服务。`;

function* chunks(text: string): Generator<string> {
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > 3000) { yield chunk; chunk = ""; }
    chunk += character;
  }
  if (chunk) yield chunk;
}

export default function createGt() {
  return definePlugin({
    apiVersion: 1, id: "gt", description: help,
    commands: {
      gt: {description: "Google 翻译", async handle({message}, context) {
        try {
          let text = message.text.replace(/^\S+\s*/, "");
          const first = text.match(/^\S+/)?.[0].toLowerCase();
          if (first === "help" || first === "h") {
            await context.telegram.edit(message, help, {parseMode: "html"});
            return;
          }
          const target = first === "en" ? "en" : "zh-CN";
          if (target === "en") text = text.replace(/^\S+\s*/, "");
          if (!text.trim()) text = (await context.telegram.getReply(message))?.text ?? "";
          if (!text.trim()) {
            await context.telegram.edit(message, "❌ 请提供要翻译的文本或回复一条文字消息");
            return;
          }
          if (text.length > 5000) {
            await context.telegram.edit(message, "❌ 文本过长，请保持在5000字符以内");
            return;
          }
          await context.telegram.edit(message, "🔄 <b>Google 翻译中...</b>", {parseMode: "html"});
          const translated = await context.http.withResponse(
            "https://translate.google.com/translate_a/single?client=at&dt=t&dt=rm&dj=1",
            {
              method: "POST",
              headers: {"Content-Type": "application/x-www-form-urlencoded;charset=utf-8"},
              body: new URLSearchParams({sl: "auto", tl: target, q: text}).toString(),
              redirect: "error",
            },
            async (response, signal) => {
              if (!response.ok) throw new Error("Translation request failed");
              if (!response.body) throw new Error("Empty translation response");
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let body = "", bytes = 0;
              try {
                while (true) {
                  signal.throwIfAborted();
                  const {done, value} = await reader.read();
                  if (done) break;
                  bytes += value.byteLength;
                  if (bytes > 256 * 1024) throw new Error("Translation response too large");
                  body += decoder.decode(value, {stream: true});
                }
                body += decoder.decode();
              } finally {
                try { await reader.cancel(); } finally { reader.releaseLock(); }
              }
              const data: unknown = JSON.parse(body);
              if (!data || typeof data !== "object" || !("sentences" in data) || !Array.isArray(data.sentences)) {
                throw new Error("Invalid translation response");
              }
              return data.sentences.map((sentence: unknown) => {
                if (!sentence || typeof sentence !== "object") throw new Error("Invalid sentence");
                if (!("trans" in sentence)) return "";
                if (typeof sentence.trans !== "string") throw new Error("Invalid translation");
                return sentence.trans;
              }).join("");
            },
            {signal: context.signal, timeoutMs: 15000},
          );
          context.signal.throwIfAborted();
          if (typeof translated !== "string" || !translated.trim()) throw new Error("Invalid translation result");
          const preview = Array.from(text).slice(0, 50).join("");
          let firstChunk = true;
          for (const chunk of chunks(translated)) {
            context.signal.throwIfAborted();
            if (firstChunk) {
              await context.telegram.edit(message,
                `🌐 <b>Google 翻译结果</b> (→ ${target === "en" ? "英文" : "中文"})\n\n` +
                `<b>原文:</b>\n<code>${escape(preview)}${preview.length < text.length ? "..." : ""}</code>\n\n` +
                `<b>译文:</b>\n${escape(chunk)}`, {parseMode: "html"});
              firstChunk = false;
            } else {
              await context.telegram.reply(message, escape(chunk), {parseMode: "html"});
            }
          }
        } catch {
          if (!context.signal.aborted) await context.telegram.edit(message,
            "❌ Google 翻译失败，请检查 Google 翻译服务的网络连接，稍后重试");
        }
      }},
    },
  });
}
