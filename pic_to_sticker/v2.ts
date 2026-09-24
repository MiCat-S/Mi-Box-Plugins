import { open, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  STRUCTURED_PLUGIN_API_VERSION,
  renderCommandHelp,
  type CommandDefinition,
  type CommandInvocation,
  type SubcommandDefinition,
  definePlugin,
  type PluginContext,
} from "telebox/sdk";
import type { Api as ApiTypes } from "teleproto";

type Config = {
  schemaVersion: number;
  defaultEmoji: string;
  quality: number;
  format: "webp" | "png";
  size: number;
  background: "transparent" | "white" | "black";
  autoDelete: boolean;
  compressionLevel: number;
};
const defaults: Config = {
  schemaVersion: 1,
  defaultEmoji: "🙂",
  quality: 90,
  format: "webp",
  size: 512,
  background: "transparent",
  autoDelete: true,
  compressionLevel: 6,
};
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_DECODE_PIXELS = 20_000_000;
class DeliveredCleanupError extends Error {}
async function writeAll(file: Awaited<ReturnType<typeof open>>, chunk: Uint8Array, signal: AbortSignal) {
  let offset = 0;
  while (offset < chunk.length) {
    signal.throwIfAborted();
    const result = await file.write(chunk, offset, chunk.length - offset);
    signal.throwIfAborted();
    if (result.bytesWritten <= 0) throw new Error("Image write failed");
    offset += result.bytesWritten;
  }
}

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );

function normalize(value: Record<string, unknown>): Config {
  const integer = (entry: unknown, fallback: number, min: number, max: number) =>
    Number.isInteger(entry) && Number(entry) >= min && Number(entry) <= max ? Number(entry) : fallback;
  return {
    ...value,
    schemaVersion: 1,
    defaultEmoji:
      typeof value.defaultEmoji === "string" && value.defaultEmoji.trim()
        ? Array.from(value.defaultEmoji).slice(0, 32).join("")
        : defaults.defaultEmoji,
    quality: integer(value.quality, defaults.quality, 1, 100),
    format: value.format === "png" ? "png" : "webp",
    size: integer(value.size, defaults.size, 256, 512),
    background: ["transparent", "white", "black"].includes(String(value.background))
      ? (value.background as Config["background"])
      : defaults.background,
    autoDelete: typeof value.autoDelete === "boolean" ? value.autoDelete : defaults.autoDelete,
    compressionLevel: integer(value.compressionLevel, defaults.compressionLevel, 0, 9),
  } as Config;
}

async function configuration(context: PluginContext, signal: AbortSignal = context.signal) {
  const store = context.storage.json("config.json", defaults);
  let current = normalize(await store.read(signal));
  signal.throwIfAborted();
  current = await store.update(value => normalize(value), signal);
  return { store, current };
}

function background(value: Config["background"]) {
  return value === "white"
    ? { r: 255, g: 255, b: 255, alpha: 1 }
    : value === "black"
      ? { r: 0, g: 0, b: 0, alpha: 1 }
      : { r: 0, g: 0, b: 0, alpha: 0 };
}

async function convert(
  context: PluginContext,
  source: ApiTypes.Message,
  config: Config,
  emoji: string,
  send: (output: string, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  if (!source.media) throw new Error("Photo required");
  if (Number(source.document?.size ?? 0) > MAX_INPUT_BYTES) throw new Error("Image too large");
  let delivered = false;
  let operationSignal: AbortSignal | undefined;
  try {
    await context.files.withTemp(async (directory, signal) => {
      operationSignal = signal;
      const input = path.join(directory, "source-image");
      const output = path.join(directory, `sticker.${config.format}`);
      await context.telegram.withClient(async (client, clientSignal) => {
        const combined = AbortSignal.any([signal, clientSignal]);
        const file = await open(input, "wx", 0o600);
        let total = 0;
        try {
          for await (const chunk of client.iterDownload(source.media! as any, { signal: combined })) {
            combined.throwIfAborted();
            total += chunk.length;
            if (total > MAX_INPUT_BYTES) throw new Error("Image too large");
            await writeAll(file, chunk, combined);
          }
          if (!total) throw new Error("Empty image");
        } finally {
          await file.close();
        }
        combined.throwIfAborted();
      });
      signal.throwIfAborted();
      const sharp = (await import("sharp")).default;
      signal.throwIfAborted();
      let operation = sharp(input, { animated: false, pages: 1, limitInputPixels: MAX_DECODE_PIXELS }).resize(
        config.size,
        config.size,
        { fit: "contain", background: background(config.background) },
      );
      operation =
        config.format === "png"
          ? operation.png({ compressionLevel: config.compressionLevel })
          : operation.webp({ quality: config.quality, effort: Math.min(6, config.compressionLevel) });
      await operation.toFile(output);
      signal.throwIfAborted();
      let info = await stat(output);
      signal.throwIfAborted();
      if (!info.isFile() || info.size === 0) throw new Error("Invalid output");
      if (info.size > 512 * 1024 && config.format === "webp") {
        await sharp(input, { animated: false, pages: 1, limitInputPixels: MAX_DECODE_PIXELS })
          .resize(config.size, config.size, { fit: "contain", background: background(config.background) })
          .webp({ quality: Math.max(10, Math.floor(config.quality * 0.6)), effort: 6 })
          .toFile(output);
        signal.throwIfAborted();
        info = await stat(output);
        signal.throwIfAborted();
      }
      if (info.size > 512 * 1024) throw new Error("Sticker too large");
      signal.throwIfAborted();
      await send(output, signal);
      delivered = true;
      signal.throwIfAborted();
    });
  } catch (error) {
    context.signal.throwIfAborted();
    operationSignal?.throwIfAborted();
    if (delivered) throw new DeliveredCleanupError();
    throw error;
  }
}

const convertReply =
  (batch: boolean): CommandDefinition["handle"] =>
  async (invocation, context) => {
    if (batch && invocation.message.replyToId === undefined) {
      await context.telegram.edit(invocation.message, help(invocation.prefix), { parseMode: "html" });
      return;
    }
    let delivered = 0;
    try {
      const config = (await configuration(context)).current;
      const reply =
        invocation.message.replyToId === undefined ? undefined : await context.telegram.getReply(invocation.message);
      context.signal.throwIfAborted();
      const source = (reply?.raw ?? invocation.message.raw) as ApiTypes.Message | undefined;
      if (!source?.media) throw new Error("Photo required");
      const raw = invocation.message.raw as ApiTypes.Message | undefined;
      if (!raw?.peerId) throw new Error("Missing peer");
      const { Api } = await import("teleproto");
      context.signal.throwIfAborted();
      const selected = batch
        ? config.defaultEmoji
        : Array.from(invocation.args[0] || config.defaultEmoji)
            .slice(0, 32)
            .join("");
      const candidates: ApiTypes.Message[] = [source];
      if (batch && (source as any).groupedId) {
        const groups = await context.telegram.withClient(async (client, clientSignal) => {
          const signal = AbortSignal.any([context.signal, clientSignal]);
          const result = await Promise.all([
            client.getMessages(raw.peerId!, { limit: 20, offsetId: source.id }),
            client.getMessages(raw.peerId!, { limit: 20, minId: source.id, reverse: true }),
          ]);
          signal.throwIfAborted();
          return result;
        });
        for (const item of groups.flat() as any[]) {
          const mime = String(item?.document?.mimeType ?? "").toLowerCase();
          const image = Boolean(item?.photo || item?.sticker || mime.startsWith("image/"));
          if (
            String(item?.groupedId ?? "") === String((source as any).groupedId) &&
            item?.media &&
            image &&
            !candidates.some(value => value.id === item.id)
          )
            candidates.push(item);
        }
      }
      candidates.sort((left, right) => left.id - right.id);
      let completed = 0,
        failed = 0;
      await context.telegram.edit(invocation.message, batch ? "🔄 正在批量处理图片..." : "🔍 正在分析图片...", {
        parseMode: "html",
      });
      for (const item of candidates.slice(0, 20)) {
        try {
          await convert(context, item, config, selected, async (output, tempSignal) =>
            context.telegram.withClient(async (client, clientSignal) => {
              const signal = AbortSignal.any([context.signal, tempSignal, clientSignal]);
              signal.throwIfAborted();
              if (!batch) await context.telegram.edit(invocation.message, "📤 正在发送贴纸...", { parseMode: "html" });
              signal.throwIfAborted();
              await client.sendFile(raw.peerId!, {
                file: output,
                attributes: [
                  new Api.DocumentAttributeSticker({ alt: selected, stickerset: new Api.InputStickerSetEmpty() }),
                ],
                replyTo: invocation.message.id,
                topMsgId: invocation.message.topicId,
              });
              signal.throwIfAborted();
            }),
          );
          completed++;
          delivered++;
        } catch (error) {
          context.signal.throwIfAborted();
          if (error instanceof DeliveredCleanupError) {
            completed++;
            delivered++;
            context.log.error("pic_to_sticker_temp_cleanup_failed");
          } else failed++;
        }
      }
      if (!completed) throw new Error("No image converted");
      if (batch)
        await context.telegram.edit(
          invocation.message,
          `✅ <b>批量转换完成</b>\n\n成功: ${completed} 张\n失败: ${failed} 张`,
          { parseMode: "html" },
        );
      if (config.autoDelete && failed === 0 && typeof raw.delete === "function") {
        if (batch) await sleep(3000, undefined, { signal: context.signal });
        context.signal.throwIfAborted();
        try {
          await raw.delete({ revoke: true });
          context.signal.throwIfAborted();
        } catch {
          context.signal.throwIfAborted();
          context.log.error("pic_to_sticker_command_cleanup_failed");
        }
      } else if (!batch)
        await context.telegram.edit(invocation.message, `✅ 贴纸已发送 ${escape(selected)}`, { parseMode: "html" });
    } catch {
      if (context.signal.aborted) return;
      if (delivered) {
        context.log.error("pic_to_sticker_receipt_failed");
        return;
      }
      context.log.error("pic_to_sticker_failed");
      await context.telegram.edit(invocation.message, "图片转换失败，请确认回复的是图片、格式受支持且输出小于 512 KiB");
    }
  };
const configure =
  (patch: (value: string | undefined) => Partial<Config> | undefined): CommandDefinition["handle"] =>
  async (i, context) => {
    const { store } = await configuration(context);
    const value = patch(i.args[0]);
    if (!value) {
      await context.telegram.edit(i.message, help(i.prefix), { parseMode: "html" });
      return;
    }
    await store.update(current => normalize({ ...current, ...value }));
    await context.telegram.edit(i.message, "配置已保存");
  };
const command: CommandDefinition = {
  description: "将回复的图片转换为 Telegram 贴纸",
  helpArgs: ["help", "h"],
  args: "[表情]",
  subcommandsCaseSensitive: false,
  examples: [{ args: "", description: "回复图片，使用默认设置转换" }, { args: "😎" }],
  subcommands: {
    batch: {
      description: "转换回复图片所在的相册，最多 20 张",
      args: "",
      examples: [{ args: "batch" }],
      handle: convertReply(true),
    },
    config: {
      description: "查看或修改转换配置",
      args: "",
      subcommands: {
        emoji: {
          description: "设置默认表情",
          args: "表情",
          examples: [{ args: "emoji 🔥" }],
          handle: configure(value => (value ? { defaultEmoji: Array.from(value).slice(0, 32).join("") } : undefined)),
        },
        size: {
          description: "设置贴纸尺寸",
          args: "256–512",
          handle: configure(value =>
            Number.isInteger(Number(value)) && Number(value) >= 256 && Number(value) <= 512
              ? { size: Number(value) }
              : undefined,
          ),
        },
        quality: {
          description: "设置输出质量",
          args: "1–100",
          handle: configure(value =>
            Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 100
              ? { quality: Number(value) }
              : undefined,
          ),
        },
        bg: {
          description: "设置背景",
          aliases: ["background"],
          args: "transparent|white|black",
          handle: configure(value =>
            ["transparent", "white", "black"].includes(value ?? "")
              ? { background: value as Config["background"] }
              : undefined,
          ),
        },
        auto: {
          description: "设置发送成功后是否删除命令消息",
          args: "on|off",
          handle: configure(value =>
            ["on", "off"].includes(value ?? "") ? { autoDelete: value === "on" } : undefined,
          ),
        },
        format: {
          description: "设置输出格式",
          args: "webp|png",
          handle: configure(value =>
            ["webp", "png"].includes(value ?? "") ? { format: value as Config["format"] } : undefined,
          ),
        },
      },
      async handle(i, context) {
        const { current } = await configuration(context);
        if (i.args.length) {
          await context.telegram.edit(i.message, help(i.prefix), { parseMode: "html" });
          return;
        }
        await context.telegram.edit(
          i.message,
          `<b>当前配置</b>\n默认表情：${escape(current.defaultEmoji)}\n尺寸：${current.size}\n质量：${current.quality}\n格式：${current.format}\n背景：${current.background}\n自动删除：${current.autoDelete ? "开启" : "关闭"}`,
          { parseMode: "html" },
        );
      },
    },
  },
  help: [
    {
      heading: "格式与默认值：",
      body: "回复 JPG/PNG/GIF/WebP 等图片，通过 sharp 保持比例并优化尺寸和质量；动画输入取首帧生成静态贴纸，输入最多 50 MiB、解码最多 2000 万像素。默认表情 🙂、512 像素、WebP 质量 90、透明背景，发送成功后删除命令。WebP 超限时再压缩一次，输出仍超过 512 KiB 会报错。",
    },
    { heading: "命令别名：", body: "<code>{prefix}pts</code> 与 <code>{prefix}pic_to_sticker</code> 使用相同参数。" },
  ],
  async handle(i, context) {
    if (["help", "h"].includes(i.args[0]?.toLowerCase() ?? "")) {
      await context.telegram.edit(i.message, help(i.prefix), { parseMode: "html" });
      return;
    }
    await convertReply(false)(i, context);
  },
};
const help = (prefix: string) => renderCommandHelp("pic_to_sticker", command, { prefix, title: "🖼️ 图片转贴纸工具" });
export default function createPicToSticker() {
  return definePlugin({
    renderHelp: help,
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "pic_to_sticker",
    description: "将图片转换为贴纸",
    commands: { pic_to_sticker: command, pts: command },
    settings: context => ({
      title: "图片转贴纸",
      description: "贴纸转换配置",
      category: "插件配置",
      icon: "🖼️",
      getSchema: () => [
        { key: "defaultEmoji", label: "默认表情", type: "string", max: 32 },
        { key: "quality", label: "质量", type: "number", min: 1, max: 100 },
        {
          key: "format",
          label: "格式",
          type: "select",
          options: [
            { value: "webp", label: "WebP" },
            { value: "png", label: "PNG" },
          ],
        },
        { key: "size", label: "尺寸", type: "number", min: 256, max: 512 },
        {
          key: "background",
          label: "背景",
          type: "select",
          options: [
            { value: "transparent", label: "透明" },
            { value: "white", label: "白色" },
            { value: "black", label: "黑色" },
          ],
        },
        { key: "autoDelete", label: "自动删除命令", type: "boolean" },
        { key: "compressionLevel", label: "压缩等级", type: "number", min: 0, max: 9 },
      ],
      async getValues(signal) {
        return (await configuration(context, signal)).current;
      },
      async setValues(patch, signal) {
        signal.throwIfAborted();
        await (await configuration(context, signal)).store.update(value => normalize({ ...value, ...patch }), signal);
      },
    }),
  });
}
