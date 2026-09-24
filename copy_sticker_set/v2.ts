import { renderHelp as renderPluginHelp } from "./v2/help";
import { Api } from "teleproto";
import { definePlugin, type CommandDefinition, type CommandInvocation, type PluginContext } from "telebox/sdk";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 120;
const CREATE_NOTICE_MS = 60_000;

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>\"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );

type ParseFailure = "help" | "link" | "limit" | "limit_max" | "name" | "title";
type ParsedInput = { ok: true; name: string; title?: string; limit: number } | { ok: false; reason: ParseFailure };

function parse(args: readonly string[]): ParsedInput {
  if (!args.length) return { ok: false, reason: "help" };
  let name = args[0]!;
  const link = /^https?:\/\//i.test(name)
    ? name
    : /^(?:www\.)?t\.me\/addstickers\//i.test(name)
      ? `https://${name}`
      : undefined;
  if (link) {
    try {
      const url = new URL(link);
      if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "link" };
      if (!["t.me", "www.t.me"].includes(url.hostname.toLowerCase())) return { ok: false, reason: "name" };
      const match = url.pathname.match(/^\/addstickers\/([A-Za-z0-9_]+)\/?$/);
      if (!match) return { ok: false, reason: "link" };
      name = match[1]!;
    } catch {
      return { ok: false, reason: "link" };
    }
  }
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) return { ok: false, reason: "name" };

  let limit = DEFAULT_LIMIT;
  const title: string[] = [];
  for (const value of args.slice(1)) {
    const match = value.match(/^limit=(\d+)$/i);
    if (!match) {
      title.push(value);
      continue;
    }
    const requested = Number(match[1]);
    if (!Number.isSafeInteger(requested) || requested < 1) return { ok: false, reason: "limit" };
    if (requested > MAX_LIMIT) return { ok: false, reason: "limit_max" };
    limit = requested;
  }
  const joined = title.join(" ").trim();
  if (joined.length > 64) return { ok: false, reason: "title" };
  return { ok: true, name, title: joined || undefined, limit };
}

function usage(prefix: string): string {
  return `<code>${escape(prefix)}copy_sticker_set</code>`;
}

function parseFailure(invocation: CommandInvocation, reason: ParseFailure): string {
  if (reason === "help") return renderPluginHelp(invocation.prefix);
  if (reason === "link") {
    return `<b>❌ 链接格式错误</b><br/><br/>无效的贴纸包链接格式<br/><br/>使用 ${usage(invocation.prefix)} 查看帮助`;
  }
  if (reason === "limit") {
    return `<b>❌ 参数错误</b><br/><br/>limit 参数无效，请使用 <code>limit=正整数</code>（最大120）<br/><br/>使用 ${usage(invocation.prefix)} 查看帮助`;
  }
  if (reason === "limit_max") {
    return `<b>❌ 参数错误</b><br/><br/>平台限制：最多 120 张贴纸。请调整 <code>limit 小于等于 120</code><br/><br/>使用 ${usage(invocation.prefix)} 查看帮助`;
  }
  if (reason === "title") {
    return `<b>❌ 参数错误</b><br/><br/>自定义标题不能超过 64 个字符<br/><br/>使用 ${usage(invocation.prefix)} 查看帮助`;
  }
  return `<b>❌ 参数错误</b><br/><br/>贴纸包短名称格式无效<br/><br/>使用 ${usage(invocation.prefix)} 查看帮助`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "errorMessage" in error &&
    typeof (error as { errorMessage?: unknown }).errorMessage === "string"
  ) {
    return (error as { errorMessage: string }).errorMessage;
  }
  return "";
}

type CreateFailure = "invalid" | "user" | "occupied" | "timeout" | "unknown";

function classifyCreateFailure(error: unknown): CreateFailure {
  const message = errorMessage(error);
  if (message.includes("STICKERSET_INVALID") || message.includes("PACK_TYPE_INVALID")) return "invalid";
  if (message.includes("PEER_ID_INVALID") || message.includes("USER_ID_INVALID")) return "user";
  if (message.includes("SHORTNAME_OCCUPY_FAILED") || message.includes("PACK_SHORT_NAME_OCCUPIED")) return "occupied";
  if (/timeout/i.test(message)) return "timeout";
  return "unknown";
}

function createFailure(invocation: CommandInvocation, failure: CreateFailure): string {
  const suffix = `<br/><br/>使用 ${usage(invocation.prefix)} 查看帮助`;
  if (failure === "invalid") return `<b>❌ 数据无效</b><br/><br/>贴纸包数据无效${suffix}`;
  if (failure === "user") return `<b>❌ 用户ID无效</b><br/><br/>用户ID无效${suffix}`;
  if (failure === "occupied") return `<b>❌ 名称被占用</b><br/><br/>贴纸包名称已被占用${suffix}`;
  if (failure === "timeout") return `<b>❌ 创建超时</b><br/><br/>创建贴纸包超时，请稍后重试或尝试较小的贴纸包${suffix}`;
  return `<b>❌ 创建错误</b><br/><br/>创建贴纸包时出现错误${suffix}`;
}

function sourceSet(value: unknown): { set: { title: string }; documents: unknown[] } | undefined {
  if (!value || typeof value !== "object") return;
  const source = value as { set?: unknown; documents?: unknown };
  if (!source.set || typeof source.set !== "object" || !Array.isArray(source.documents)) return;
  const title = (source.set as { title?: unknown }).title;
  if (typeof title !== "string") return;
  return { set: { title }, documents: source.documents };
}

function scheduleCreateNotice(context: PluginContext, invocation: CommandInvocation): () => Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let notification: Promise<void> | undefined;
  let releaseTimer!: () => Promise<void>;
  releaseTimer = context.tasks.add("copy_sticker_set:create-timeout-notice", () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  });
  timer = setTimeout(() => {
    timer = undefined;
    if (context.signal.aborted) {
      void releaseTimer();
      return;
    }
    notification = context.tasks
      .run("copy_sticker_set:create-timeout-notification", async signal => {
        signal.throwIfAborted();
        await context.telegram.edit(
          invocation.message,
          "⏳ 创建贴纸包超时，操作仍在等待服务器确认。请勿重复提交；收到服务器结果后会继续更新此消息。",
        );
      })
      .catch(() => {
        if (!context.signal.aborted) context.log.error("copy_sticker_set_timeout_notice_failed");
      });
    void notification.then(() => {
      void releaseTimer();
    });
  }, CREATE_NOTICE_MS);
  return async () => {
    await releaseTimer();
    if (notification) await notification;
  };
}

export default function createCopyStickerSet() {
  const command: CommandDefinition = {
    description: "将现有贴纸包复制到自己的账户",
    helpArgs: ["help", "h"],
    helpOnEmpty: true,
    async handle(invocation, context) {
      const input = parse(invocation.args);
      if (!input.ok) {
        await context.telegram.edit(invocation.message, parseFailure(invocation, input.reason), {
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      await context.telegram.edit(invocation.message, "🔍 正在获取贴纸包信息...");
      let response: unknown;
      try {
        response = await context.telegram.withClient(async (client, signal) => {
          signal.throwIfAborted();
          const result = await client.invoke(
            new Api.messages.GetStickerSet({
              stickerset: new Api.InputStickerSetShortName({ shortName: input.name }),
              hash: 0,
            }),
          );
          signal.throwIfAborted();
          return result;
        });
      } catch {
        context.signal.throwIfAborted();
        context.log.error("copy_sticker_set_lookup_failed");
        await context.telegram.edit(
          invocation.message,
          `<b>❌ 贴纸包不存在</b><br/><br/>无法找到贴纸包：<code>${escape(input.name)}</code><br/>请检查贴纸包名称是否正确<br/><br/>使用 ${usage(invocation.prefix)} 查看帮助`,
          { parseMode: "html" },
        );
        return;
      }

      const source = sourceSet(response);
      if (!source) {
        context.log.error("copy_sticker_set_lookup_invalid_response");
        await context.telegram.edit(
          invocation.message,
          `<b>❌ 获取失败</b><br/><br/>获取贴纸包信息失败<br/><br/>使用 ${usage(invocation.prefix)} 查看帮助`,
          { parseMode: "html" },
        );
        return;
      }
      if (!source.documents.length) {
        await context.telegram.edit(
          invocation.message,
          `<b>❌ 贴纸包为空</b><br/><br/>贴纸包中没有贴纸<br/><br/>使用 ${usage(invocation.prefix)} 查看帮助`,
          { parseMode: "html" },
        );
        return;
      }

      await context.telegram.edit(
        invocation.message,
        `📦 找到贴纸包：${escape(source.set.title)}<br/>🎯 包含 ${source.documents.length} 个贴纸<br/><br/>⏳ 开始复制贴纸包...`,
        { parseMode: "html" },
      );

      const selected = source.documents.slice(0, input.limit);
      if (source.documents.length > selected.length) {
        await context.telegram.edit(
          invocation.message,
          `📦 贴纸包：${escape(source.set.title)}<br/>🎯 原包含 ${source.documents.length} 个贴纸<br/>` +
            `⚠️ 为避免超时，将只复制前 ${selected.length} 个贴纸（limit=${input.limit}，最大允许 ${MAX_LIMIT}）<br/><br/>⏳ 开始处理贴纸...`,
          { parseMode: "html" },
        );
      }

      const stickers: Api.InputStickerSetItem[] = [];
      for (const [index, document] of selected.entries()) {
        context.signal.throwIfAborted();
        await context.telegram.edit(
          invocation.message,
          `📦 贴纸包：${escape(source.set.title)}<br/>🎯 处理贴纸 ${index + 1}/${selected.length}...`,
          { parseMode: "html" },
        );
        if (!(document instanceof Api.Document)) continue;
        try {
          const attribute = (document.attributes ?? []).find(value => value instanceof Api.DocumentAttributeSticker);
          const emoji = attribute instanceof Api.DocumentAttributeSticker && attribute.alt ? attribute.alt : "🙂";
          stickers.push(
            new Api.InputStickerSetItem({
              document: new Api.InputDocument({
                id: document.id,
                accessHash: document.accessHash,
                fileReference: document.fileReference ?? Buffer.alloc(0),
              }),
              emoji,
            }),
          );
        } catch {
          context.log.error("copy_sticker_set_item_skipped");
        }
      }

      if (!stickers.length) {
        await context.telegram.edit(
          invocation.message,
          `<b>❌ 处理失败</b><br/><br/>无法处理任何贴纸<br/><br/>使用 ${usage(invocation.prefix)} 查看帮助`,
          { parseMode: "html" },
        );
        return;
      }

      await context.telegram.edit(
        invocation.message,
        `📦 贴纸包：${escape(source.set.title)}<br/>🎯 已处理 ${stickers.length} 个贴纸<br/><br/>🚀 正在创建新贴纸包...`,
        { parseMode: "html" },
      );

      const suffix = Date.now().toString(36);
      const stem =
        input.name
          .toLowerCase()
          .replace(/_+/g, "_")
          .slice(0, 40)
          .replace(/^_+|_+$/g, "") || "stickers";
      const shortName = `mibox_${stem}_${suffix}`.slice(0, 64);
      const title = input.title || `${source.set.title} (复制)`;
      let result: unknown;
      const stopCreateNotice = scheduleCreateNotice(context, invocation);
      try {
        result = await context.telegram.withClient(async (client, signal) => {
          signal.throwIfAborted();
          const created = await client.invoke(
            new Api.stickers.CreateStickerSet({
              userId: new Api.InputUserSelf(),
              title,
              shortName,
              stickers,
            }),
          );
          signal.throwIfAborted();
          return created;
        });
      } catch (error) {
        context.signal.throwIfAborted();
        const failure = classifyCreateFailure(error);
        context.log.error(`copy_sticker_set_create_${failure}`);
        await context.telegram.edit(invocation.message, createFailure(invocation, failure), { parseMode: "html" });
        return;
      } finally {
        await stopCreateNotice();
      }

      if (!(result instanceof Api.messages.StickerSet)) {
        context.log.error("copy_sticker_set_create_invalid_response");
        await context.telegram.edit(
          invocation.message,
          `<b>❌ 创建失败</b><br/><br/>创建贴纸包失败，请稍后重试<br/><br/>使用 ${usage(invocation.prefix)} 查看帮助`,
          { parseMode: "html" },
        );
        return;
      }

      await context.telegram.edit(
        invocation.message,
        `<b>✅ 贴纸包复制完成</b><br/><br/>📦 原贴纸包：${escape(source.set.title)}<br/>` +
          `🆕 新贴纸包：${escape(title)}<br/>📊 数量：${stickers.length}（limit=${input.limit}）<br/>` +
          `<a href="https://t.me/addstickers/${shortName}">打开新贴纸包</a>`,
        { parseMode: "html", linkPreview: false },
      );
    },
  };

  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "copy_sticker_set",
    description: "复制 Telegram 贴纸包",
    commands: { copy_sticker_set: command, css: command },
  });
}
