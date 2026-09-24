import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, type PluginContext } from "telebox/sdk";
import { CustomFile } from "teleproto/client/uploads";
import { Api, helpers, utils } from "teleproto";
const api = "https://api.txqq.pro/api/zt.php";
const MAX_TEXT_LENGTH = 500;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_777_216;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function responseBytes(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error("图片服务不可用");
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_IMAGE_BYTES) throw new Error("图片过大");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  let cancellation: Promise<void> | undefined;
  const cancel = () => (cancellation ??= reader.cancel());
  const abort = () => {
    void cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) {
        complete = true;
        break;
      }
      total += part.value.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new Error("图片过大");
      chunks.push(part.value);
    }
    if (!total) throw new Error("图片为空");
    return Buffer.concat(chunks, total);
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      if (!complete) await cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

async function prepareImage(image: Buffer, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const { default: sharp } = await import("sharp");
  signal.throwIfAborted();
  const input = sharp(image, { limitInputPixels: MAX_IMAGE_PIXELS, animated: false, pages: 1 });
  const metadata = await input.metadata();
  signal.throwIfAborted();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS)
    throw new Error("图片尺寸无效");
  if (metadata.format === "jpeg") return image;
  const output = await input.jpeg({ quality: 90 }).toBuffer();
  signal.throwIfAborted();
  if (!output.length || output.length > MAX_IMAGE_BYTES) throw new Error("图片过大");
  return output;
}

export function peerFromChatId(chatId: string): Api.TypePeer {
  const [id, Peer] = utils.resolveId(helpers.returnBigInt(chatId));
  if (Peer === Api.PeerUser) return new Api.PeerUser({ userId: id });
  if (Peer === Api.PeerChat) return new Api.PeerChat({ chatId: id });
  return new Api.PeerChannel({ channelId: id });
}

export default function createJupai() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "jupai",
    description: "生成举牌小人图片",
    commands: {
      jupai: {
        description: "生成举牌小人图片",
        helpArgs: ["help", "h"],
        async handle(invocation, ctx: PluginContext) {
          let text = invocation.args.join(" ").trim();
          if (["help", "h"].includes(text.toLowerCase())) {
            await ctx.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), { parseMode: "html" });
            return;
          }
          if (!text) {
            const reply = await ctx.telegram.getReply(invocation.message);
            ctx.signal.throwIfAborted();
            text = reply?.text?.trim() ?? "";
          }
          if (!text) {
            await ctx.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), { parseMode: "html" });
            return;
          }
          if (text.length > MAX_TEXT_LENGTH) {
            await ctx.telegram.edit(invocation.message, "文本过长，最多支持 500 字符");
            return;
          }
          try {
            await ctx.telegram.edit(invocation.message, "正在生成举牌小人…");
            ctx.signal.throwIfAborted();
            const response = await ctx.http.withResponse(
              `${api}?msg=${encodeURIComponent(text)}`,
              { credentials: "omit" },
              responseBytes,
              { timeoutMs: 60000, redirects: { allowedHosts: ["api.txqq.pro"], maxRedirects: 2 } },
            );
            ctx.signal.throwIfAborted();
            const image = await prepareImage(response, ctx.signal);
            const raw = invocation.message.raw as Api.Message | undefined;
            await ctx.telegram.withClient(async (client, clientSignal) => {
              const signal = AbortSignal.any([ctx.signal, clientSignal]);
              signal.throwIfAborted();
              await client.sendFile(raw?.peerId ?? peerFromChatId(invocation.message.chatId), {
                file: new CustomFile("jupai.jpg", image.length, "", image),
                replyTo: invocation.message.replyToId ?? invocation.message.id,
              });
              signal.throwIfAborted();
              if (typeof raw?.delete === "function") {
                try {
                  await raw.delete({ revoke: true });
                } catch {
                  ctx.log.info("jupai_receipt_cleanup_failed");
                }
                signal.throwIfAborted();
              } else {
                await ctx.telegram.edit(invocation.message, "举牌小人已发送");
              }
            });
          } catch {
            if (!ctx.signal.aborted)
              await ctx.telegram.edit(invocation.message, `生成失败，请稍后重试（${esc(text.slice(0, 80))}）`, {
                parseMode: "html",
              });
          }
        },
      },
    },
  });
}
