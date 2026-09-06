import {definePlugin, type PluginContext, type CommandInvocation} from "telebox/sdk";
import {escape, native, replyMessage, UserError} from "./v2/runtime";
import {generateQuote, sendQuote} from "./v2/media";
import {quoteData, type QuoteOptions} from "./v2/quote";
import {saveSticker} from "./v2/stickers";

const defaults = {stickerSetShortName: "", _comment: "如果贴纸包不存在，将自动创建。shortName 只能包含字母、数字和下划线"};
const store = (ctx: PluginContext) => ctx.storage.json("config.json", defaults);

function help(prefix: string): string {
  const command = escape(`${prefix}yvlu`);
  return `<b>生成文字语录贴纸</b>\n\n` + [
    `<code>${command} [消息数]</code> 回复消息生成语录，最多 5 条，支持选择部分引用`,
    `<code>${command} r [消息数]</code> 包含被引用内容`,
    `<code>${command} f 文本</code> 伪造文本；<code>fr 文本</code> 同时包含回复`,
    `<code>${command} u 用户ID/用户名 [消息数]</code> 伪造发送者；<code>ur</code> 同时包含回复`,
    `<code>${command} webp|image|png|stories [消息数]</code> 静态 WebP、背景 PNG、故事模式 720×1280 PNG`,
    `<code>${command} r webp|image|png|stories [消息数]</code> 指定格式并包含回复`,
    `<code>${command} s</code> 保存回复的贴纸或图片到贴纸包`,
    `<code>${command} config</code> 查看配置`,
    `<code>${command} config sticker 贴纸包名称</code> 设置贴纸包（别名 stickerset、set）`,
  ].join("\n");
}

export function parseQuote(invocation: CommandInvocation): QuoteOptions | undefined {
  const args = invocation.message.text.trim().split(/\s+/).slice(1);
  const sub = args[0];
  const result: QuoteOptions = {count: 1, includeReply: false, format: "webp"};
  const format = (value?: string) => ["webp", "image", "png", "stories"].includes(value || "");
  const count = (value?: string) => parseInt(value || "", 10) || 1;
  if (!sub || /^\d+$/.test(sub)) result.count = count(sub);
  else if (sub === "r") {
    result.includeReply = true;
    if (format(args[1])) { result.format = (args[1] === "png" ? "image" : args[1]) as QuoteOptions["format"]; result.count = count(args[2]); }
    else result.count = count(args[1]);
  } else if (["u", "ur"].includes(sub) && args[1]) {
    result.includeReply = sub === "ur"; result.count = count(args[2]);
  } else if (["f", "fr"].includes(sub) && args[1]) {
    result.includeReply = sub === "fr";
    const match = invocation.message.text.match(/^\S+\s+fr?\s+/);
    if (!match) return undefined;
    const offset = match[0].length;
    const entities = ((invocation.message.raw as any)?.entities || []).filter((entity: any) => entity.offset + entity.length > offset)
      .map((entity: any) => Object.assign(Object.create(Object.getPrototypeOf(entity)), entity, {
        offset: Math.max(0, entity.offset - offset), length: entity.length - Math.max(0, offset - entity.offset),
      }));
    result.fakeText = {text: invocation.message.text.slice(offset), entities};
  } else if (format(sub)) { result.format = (sub === "png" ? "image" : sub) as QuoteOptions["format"]; result.count = count(args[1]); }
  else return undefined;
  return result;
}

async function handle(invocation: CommandInvocation, ctx: PluginContext): Promise<void> {
  const {message, prefix} = invocation;
  const args = message.text.trim().split(/\s+/).slice(1);
  const edit = (text: string, html = false) => ctx.telegram.edit(message, text, html ? {parseMode: "html"} : {});
  try {
    if (args[0] === "config") {
      if (!args[1]) {
        const config = await store(ctx).read(ctx.signal);
        await edit(`<b>当前配置</b>\n贴纸包名称：<code>${escape(config.stickerSetShortName || "(未设置)")}</code>\n` +
          (config.stickerSetShortName ? `贴纸包链接：t.me/addstickers/${escape(config.stickerSetShortName)}\n` : "") +
          `配置文件路径：<code>${escape(ctx.files.dataPath("config.json"))}</code>\n` +
          `<code>${escape(prefix)}yvlu config sticker 贴纸包名称</code>`, true);
        return;
      }
      if (!["sticker", "stickerset", "set"].includes(args[1].toLowerCase())) {
        throw new UserError(`未知的配置项：${args[1]}。可用配置命令：${prefix}yvlu config sticker 贴纸包名称`);
      }
      const name = args.slice(2).join("_");
      if (!name) throw new UserError(`请提供贴纸包名称，用法：${prefix}yvlu config sticker 贴纸包名称`);
      if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new UserError("贴纸包名称只能包含字母、数字和下划线");
      if (name.length > 64) throw new UserError("贴纸包名称长度应在 1-64 个字符之间");
      await store(ctx).update(data => ({...data, stickerSetShortName: name}), ctx.signal);
      await edit(`已设置贴纸包：${name}\n贴纸包链接：t.me/addstickers/${name}`);
      return;
    }
    if (args[0] === "s") {
      const config = await store(ctx).read(ctx.signal);
      const created = await saveSticker(ctx, message, config.stickerSetShortName);
      await edit(`${created ? "已创建贴纸包并添加第一个贴纸" : "已成功添加到贴纸包"}\n贴纸包：t.me/addstickers/${config.stickerSetShortName}`);
      return;
    }
    const options = parseQuote(invocation);
    if (!options) { await edit(help(prefix), true); return; }
    if (["u", "ur"].includes(args[0])) {
      try {
        const {returnBigInt} = await import("teleproto/Helpers.js");
        options.fakeSender = await native(ctx, client => client.getEntity(/^-?\d+$/.test(args[1]) ? returnBigInt(args[1]) : args[1]));
        if (!options.fakeSender) throw new Error("Missing sender");
      } catch {
        ctx.signal.throwIfAborted();
        throw new UserError(`无法获取 ${args[1]} 的信息，请检查用户ID/用户名是否正确`);
      }
    }
    const replied = await replyMessage(ctx, message);
    if (!replied) throw new UserError("请回复一条消息");
    if (options.count > 5) throw new UserError("太多了 哒咩");
    await edit("正在生成语录贴纸...");
    const data = await quoteData(ctx, message, replied, options);
    const result = await generateQuote(ctx, data);
    await sendQuote(ctx, (message.raw as any)?.peerId || message.chatId, replied.id, result);
    await native(ctx, client => client.deleteMessages((message.raw as any)?.peerId || message.chatId, [message.id], {revoke: true}));
  } catch (error) {
    ctx.signal.throwIfAborted();
    ctx.log.error("yvlu.command.failed");
    await edit(error instanceof UserError ? error.message : "语录操作失败，请检查网络、媒体转换依赖或贴纸包权限后重试");
  }
}

export default function createYvlu() {
  return definePlugin({apiVersion: 1, id: "yvlu", description: "生成文字语录贴纸、图片与故事，管理贴纸包",
    commands: {yvlu: {description: "生成语录、保存贴纸及配置贴纸包", handle}},
  });
}
