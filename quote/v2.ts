import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  STRUCTURED_PLUGIN_API_VERSION,
  definePlugin,
  renderCommandHelp,
  requireSdkFeatures,
  type CommandDefinition,
  type CommandInvocation,
  type MessageEnvelope,
  type PluginContext,
} from "telebox/sdk";
import { returnBigInt } from "teleproto/Helpers.js";
import { createAssetLoader } from "./v2/assets";
import { toQuoteMessages } from "./v2/messages";
import { renderQuote } from "./v2/render";
import { clearResources } from "./generate.js";

requireSdkFeatures("httpAddressPolicy");

export interface QuoteOptions {
  count: number;
  replies: boolean;
  media: boolean;
  imagePreview: boolean;
  crop: boolean;
  hidden: boolean;
  scale: number;
  format: "webp" | "png" | "story";
  background: string;
  emojiBrand: string;
  explicitCount: boolean;
}
const BRANDS = new Set(["apple", "google", "twitter", "joypixels", "blob"]);
const isColor = (value: string) =>
  value.toLowerCase() === "random" ||
  /^#(?:[\da-f]{3}|[\da-f]{6})(\/#(?:[\da-f]{3}|[\da-f]{6}))?$/i.test(value) ||
  /^\/\/#?(?:[\da-f]{3}|[\da-f]{6})$/i.test(value) ||
  /^(?:[\da-f]{3}|[\da-f]{6})(\/(?:[\da-f]{3}|[\da-f]{6}))?$/i.test(value);
function color(value: string): string {
  if (value.toLowerCase() === "random")
    return `#${Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, "0")}`;
  if (value.startsWith("#") || value.startsWith("//")) return value;
  return /^[\da-f]{3,6}(\/[\da-f]{3,6})?$/i.test(value)
    ? value
        .split("/")
        .map(part => `#${part}`)
        .join("/")
    : value;
}
export function parseOptions(args: readonly string[]): QuoteOptions {
  const result: QuoteOptions = {
    count: 1,
    replies: false,
    media: false,
    imagePreview: false,
    crop: false,
    hidden: false,
    scale: 2,
    format: "webp",
    background: "#231d2b/#372e44",
    emojiBrand: "apple",
    explicitCount: false,
  };
  for (let index = 0; index < args.length; index++) {
    const raw = args[index]!,
      token = raw.toLowerCase();
    if (["r", "reply"].includes(token)) {
      result.replies = true;
      continue;
    }
    if (["png", "image", "img"].includes(token)) {
      result.imagePreview = true;
      if (result.format !== "story") result.format = "png";
      continue;
    }
    if (["story", "stories"].includes(token)) {
      result.format = "story";
      continue;
    }
    if (["webp", "quote"].includes(token)) {
      result.format = "webp";
      continue;
    }
    if (["hidden", "hide", "anonymous"].includes(token)) {
      result.hidden = true;
      continue;
    }
    if (["media", "m"].includes(token)) {
      result.media = true;
      continue;
    }
    if (token === "crop") {
      result.crop = true;
      continue;
    }
    if (["rate", "rating"].includes(token)) continue;
    const scale = token.match(/^(?:scale|s)[=:](\d+(?:\.\d+)?)$/);
    if (scale) {
      const value = Number(scale[1]);
      if (Number.isFinite(value) && value > 0) result.scale = Math.min(20, Math.max(1, value));
      continue;
    }
    if (["scale", "s"].includes(token)) {
      const next = Number(args[index + 1]);
      if (Number.isFinite(next) && next > 0) {
        result.scale = Math.min(20, Math.max(1, next));
        index++;
      }
      continue;
    }
    const background = raw.match(/^(?:bg|color|background)[=:](.+)$/i);
    if (background) {
      result.background = color(background[1]!);
      continue;
    }
    if (["bg", "color", "background"].includes(token)) {
      if (args[index + 1] && isColor(args[index + 1]!)) result.background = color(args[++index]!);
      continue;
    }
    if (isColor(raw)) {
      result.background = color(raw);
      continue;
    }
    if (BRANDS.has(token)) {
      result.emojiBrand = token;
      continue;
    }
    const brand = token.match(/^(?:emoji|brand)[=:]([a-z]+)$/);
    if (brand && BRANDS.has(brand[1]!)) {
      result.emojiBrand = brand[1]!;
      continue;
    }
    if (/^[+-]?\d+$/.test(token)) {
      result.count = Math.max(-50, Math.min(50, Number(token))) || 1;
      result.explicitCount = true;
    }
    // Legacy ignores unrecognized options; keep that compatibility contract.
  }
  return result;
}
export function wantsHelp(args: readonly string[]): boolean {
  const text = args.join(" ").trim().toLowerCase();
  return /^(help|\?|h|帮助)$/.test(text) || /(?:^|\s)(help|\?|帮助)(?:\s|$)/.test(text);
}
export async function collectMessages(ctx: PluginContext, invocation: CommandInvocation, options: QuoteOptions) {
  let reply: MessageEnvelope | undefined;
  try {
    reply = await ctx.telegram.getReply(invocation.message);
  } catch {
    ctx.signal.throwIfAborted();
  }
  ctx.signal.throwIfAborted();
  const base = reply ?? invocation.message;
  const source = { raw: base.raw ?? { id: base.id, message: base.text }, envelope: base };
  const replyTo = reply?.id ?? (options.explicitCount ? invocation.message.id : base.id);
  if (Math.abs(options.count) <= 1) return { sources: [source], replyTo };
  const limit = Math.abs(options.count);
  const query = reply
    ? options.count > 0
      ? { offsetId: base.id - 1, limit, reverse: true }
      : { offsetId: base.id + 1, limit }
    : { offsetId: invocation.message.id + (options.count < 0 ? 1 : 0), limit };
  const peer = (base.raw as any)?.peerId ?? (invocation.message.raw as any)?.peerId ?? returnBigInt(base.chatId);
  try {
    const messages = await ctx.telegram.withClient(async (client, signal) => {
      signal.throwIfAborted();
      const result = await client.getMessages(peer, query);
      signal.throwIfAborted();
      return (result ?? [])
        .filter(
          (value: any) =>
            value && Number.isSafeInteger(value.id) && (!value.className || value.className === "Message"),
        )
        .sort((a: any, b: any) => a.id - b.id);
    });
    return { sources: messages.length ? messages.slice(0, limit).map(raw => ({ raw })) : [source], replyTo };
  } catch {
    ctx.signal.throwIfAborted();
    return { sources: [source], replyTo };
  }
}
async function progress(ctx: PluginContext, message: MessageEnvelope, text: string) {
  try {
    await ctx.telegram.edit(message, text);
  } catch {
    ctx.signal.throwIfAborted();
    ctx.log.error("quote_progress_failed");
  }
}
export default function createQuote() {
  const ensureAssets = createAssetLoader();
  let assetRoot: string | undefined;
  const command: CommandDefinition = {
    description: "按原版 glass 样式将消息渲染为语录",
    args: "[数量] [image|stories] [选项]",
    helpArgs: ["help", "h", "?", "帮助"],
    arguments: [
      { name: "数量", description: "最多 50 条；回复时正数向后、负数向前。无回复时正数取命令之前的消息。" },
      {
        name: "选项",
        description: "r/reply、hidden、media、crop、scale=1..20、bg=颜色、apple/google/twitter/joypixels/blob。",
      },
    ],
    examples: [{ args: "" }, { args: "3 image bg=#aaa/#bbb" }, { args: "stories" }, { args: "r google" }],
    help: [
      {
        heading: "原版格式与资源：",
        body: "默认 WebP 贴纸、scale=2；image/png 为背景大图，stories 为 720×1280 PNG。首次使用从原固定来源下载字体、背景和表情素材到插件数据目录；之后复用。",
      },
      {
        heading: "资源边界：",
        body: "消息最多 50 条；媒体单项 12 MiB、合计 32 MiB。单画布最多 2000 万像素；高缩放或长内容超过预算会明确失败。代码和依赖由宿主提供。",
      },
    ],
    async handle(invocation, ctx) {
      if (wantsHelp(invocation.args)) {
        await ctx.telegram.edit(invocation.message, help(invocation.prefix), { parseMode: "html" });
        return;
      }
      let sent = false;
      try {
        const options = parseOptions(invocation.args);
        await progress(ctx, invocation.message, "⏳ 正在生成 quote…");
        const collected = await collectMessages(ctx, invocation, options);
        const messages = await toQuoteMessages(ctx, collected.sources, options);
        const root = await ensureAssets(ctx);
        assetRoot = root;
        const result = await renderQuote(messages, options, ctx.signal, root);
        ctx.signal.throwIfAborted();
        const webp = result.subarray(0, 4).toString() === "RIFF" && result.subarray(8, 12).toString() === "WEBP";
        if (!result.length || result.length > (webp ? 512 * 1024 : 20 * 1024 * 1024))
          throw new Error("QUOTE_OUTPUT_BUDGET");
        await progress(ctx, invocation.message, "✅ quote 已生成，正在发送…");
        await ctx.files.withTemp(async (directory, signal) => {
          const file = path.join(directory, `quote.${webp ? "webp" : "png"}`);
          await writeFile(file, result, { signal, mode: 0o600, flag: "wx" });
          await ctx.telegram.withClient(async (client, active) => {
            const { Api } = await import("teleproto");
            const combined = AbortSignal.any([signal, active]);
            combined.throwIfAborted();
            const peer = (invocation.message.raw as any)?.peerId ?? returnBigInt(invocation.message.chatId);
            await client.sendFile(peer, {
              file,
              forceDocument: false,
              replyTo: collected.replyTo,
              topMsgId: invocation.message.topicId,
              ...(webp
                ? {
                    attributes: [
                      new Api.DocumentAttributeSticker({ alt: "💜", stickerset: new Api.InputStickerSetEmpty() }),
                    ],
                  }
                : {}),
            });
            sent = true;
            combined.throwIfAborted();
            try {
              const raw = invocation.message.raw as any;
              if (typeof raw?.delete === "function") await raw.delete();
              else await client.deleteMessages(peer, [invocation.message.id], { revoke: true });
              combined.throwIfAborted();
            } catch {
              combined.throwIfAborted();
              ctx.log.error("quote_command_cleanup_failed");
            }
          });
        });
      } catch {
        if (ctx.signal.aborted) return;
        if (sent) {
          ctx.log.error("quote_temp_cleanup_failed");
          return;
        }
        ctx.log.error("quote_failed");
        await ctx.telegram.edit(invocation.message, "引用生成失败，请检查参数、依赖或稍后重试");
      }
    },
  };
  const help = (prefix: string) => renderCommandHelp("quote", command, { prefix, title: "💬 本地语录" });
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "quote",
    description: "本地 glass 语录渲染",
    cleanup() {
      if (assetRoot) clearResources(assetRoot);
    },
    renderHelp: help,
    commands: { q: command, quote: command },
  });
}
