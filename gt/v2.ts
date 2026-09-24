import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, ui } from "telebox/sdk";

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
class OutputDeliveryError extends Error {
  constructor() {
    super("GT_OUTPUT_DELIVERY_FAILED");
  }
}

function* chunks(text: string): Generator<string> {
  let chunk = "";
  for (const character of text) {
    const escaped = escape(character);
    if (chunk.length + escaped.length > 3000) {
      yield chunk;
      chunk = "";
    }
    chunk += escaped;
  }
  if (chunk) yield chunk;
}

export default function createGt() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "gt",
    description: "使用 AI 插件当前聊天模型翻译文本",
    commands: {
      gt: {
        helpArgs: ["help", "h"],
        description: "AI 翻译",
        async handle({ message, prefix }, context) {
          try {
            let text = message.text.replace(/^\S+\s*/, "");
            const first = text.match(/^\S+/)?.[0].toLowerCase();
            if (first === "help" || first === "h") {
              await context.telegram.edit(message, renderPluginHelp(prefix), { parseMode: "html" });
              return;
            }
            const target = first === "en" ? "en" : "zh-CN";
            if (target === "en") text = text.replace(/^\S+\s*/, "");
            if (!text.trim()) text = (await context.telegram.getReply(message))?.text ?? "";
            if (!text.trim()) {
              await context.telegram.edit(message, "❌ 请提供要翻译的文本或回复一条文字消息", { parseMode: "html" });
              return;
            }
            if (text.length > 5000) {
              await context.telegram.edit(message, "❌ 文本过长，请保持在5000字符以内", { parseMode: "html" });
              return;
            }
            if (!context.services.available("ai", "translate")) {
              await context.telegram.edit(message, "❌ 请先安装或更新配套 ai 插件，并配置 ai model chat", {
                parseMode: "html",
              });
              return;
            }
            await context.telegram.edit(message, "🔄 <b>AI 翻译中...</b>", { parseMode: "html" });
            const translated = await context.services.call<unknown>(
              "ai",
              "translate",
              { text, target },
              context.signal,
            );
            context.signal.throwIfAborted();
            if (typeof translated !== "string" || !translated.trim()) throw new Error("Invalid translation result");
            const preview = Array.from(text).slice(0, 50).join("");
            const output = [...chunks(translated)];
            output[0] =
              `🌐 <b>AI 翻译结果</b> (→ ${target === "en" ? "英文" : "中文"})\n\n` +
              `<b>原文:</b>\n<code>${escape(preview)}${preview.length < text.length ? "..." : ""}</code>\n\n` +
              `<b>译文:</b>\n${output[0]}`;
            const delivery = await ui.deliverPages(output, context.signal, (page, index) =>
              index
                ? context.telegram.reply(message, page, { parseMode: "html" })
                : context.telegram.edit(message, page, { parseMode: "html" }),
            );
            if (delivery.interrupted) {
              context.log.info("gt_delivery_interrupted", {
                published: delivery.published,
                total: delivery.total,
                category: ui.deliveryErrorCategory(delivery.error),
              });
              if (!delivery.published) throw new OutputDeliveryError();
              try {
                await context.telegram.reply(message, ui.interruptedNotice(delivery), { parseMode: "html" });
              } catch {}
            }
          } catch (error) {
            if (error instanceof OutputDeliveryError) throw error;
            if (!context.signal.aborted)
              await context.telegram.edit(message, "❌ AI 翻译失败，请检查 ai 聊天配置、API 可用性及超时设置后重试", {
                parseMode: "html",
              });
          }
        },
      },
    },
  });
}
