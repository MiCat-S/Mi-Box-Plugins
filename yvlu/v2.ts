import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin, ui, type PluginContext, type CommandInvocation} from "telebox/sdk";
import {escape, native, replyMessage, UserError} from "./v2/runtime";
import {generateQuote, sendQuote} from "./v2/media";
import {quoteData, type QuoteOptions} from "./v2/quote";
import {saveSticker} from "./v2/stickers";

const defaults = {stickerSetShortName: "", _comment: "如果贴纸包不存在，将自动创建。shortName 只能包含字母、数字和下划线"};
const store = (ctx: PluginContext) => ctx.storage.json("config.json", defaults);

const htmlOptions = {parseMode: "html", linkPreview: false} as const;
function feedback(state: "working" | "success" | "error", title: string, detail?: string): ui.Html {
  return ui.renderFeedback({state, title, ...(detail ? {detail} : {})});
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

const guarded = (operation: (invocation: CommandInvocation, ctx: PluginContext, edit: (text: string, html?: boolean) => Promise<void>) => Promise<void>): CommandDefinition["handle"] => async (invocation, ctx) => {
  const edit = (text: string, html = false) => ctx.telegram.edit(invocation.message, text, html ? htmlOptions : {});
  try { await operation(invocation, ctx, edit); }
  catch (error) {
    ctx.signal.throwIfAborted();
    ctx.log.error("yvlu.command.failed");
    await edit(feedback("error", "语录操作失败", error instanceof UserError ? error.message : "请检查网络、媒体转换依赖或贴纸包权限后重试"), true);
  }
};
const quote: CommandDefinition["handle"] = guarded(async (invocation, ctx, edit) => {
  const {message, prefix} = invocation;
  const args = message.text.trim().split(/\s+/).slice(1);
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
    await edit(feedback("working", "正在生成语录贴纸"), true);
    const data = await quoteData(ctx, message, replied, options);
    const result = await generateQuote(ctx, data);
    await sendQuote(ctx, (message.raw as any)?.peerId || message.chatId, replied.id, result);
    await native(ctx, client => client.deleteMessages((message.raw as any)?.peerId || message.chatId, [message.id], {revoke: true}));
});
const command: CommandDefinition = {
  description: "生成语录、保存贴纸及配置贴纸包", args: "[消息数]", subcommandsCaseSensitive: true,
  examples: [{args: "", description: "回复一条消息生成语录"}, {args: "3"}],
  subcommands: {
    config: {description: "查看或修改贴纸包配置", args: "", subcommandsCaseSensitive: false, subcommands: {
      sticker: {description: "设置贴纸包名称", aliases: ["stickerset", "set"], args: "贴纸包名称", examples: [{args: "sticker MyQuotes"}], help: [{body: "名称仅含字母、数字和下划线，1–64 字符；多个词会用下划线连接。"}], handle: guarded(async (invocation, ctx, edit) => {
        const {prefix} = invocation;
      const name = invocation.args.join("_");
      if (!name) throw new UserError(`请提供贴纸包名称，用法：${prefix}yvlu config sticker 贴纸包名称`);
      if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new UserError("贴纸包名称只能包含字母、数字和下划线");
      if (name.length > 64) throw new UserError("贴纸包名称长度应在 1-64 个字符之间");
      await store(ctx).update(data => ({...data, stickerSetShortName: name}), ctx.signal);
      await edit(feedback("success", "贴纸包配置已更新", `已设置贴纸包：${name}\n贴纸包链接：t.me/addstickers/${name}`), true);
      return;
          })},
    }, handle: guarded(async (invocation, ctx, edit) => {
      const {prefix} = invocation;
      if (invocation.args.length) throw new UserError(`未知的配置项：${invocation.args[0]}。可用配置命令：${prefix}yvlu config sticker 贴纸包名称`);
        const config = await store(ctx).read(ctx.signal);
        await edit(`<b>当前配置</b>\n贴纸包名称：<code>${escape(config.stickerSetShortName || "(未设置)")}</code>\n` +
          (config.stickerSetShortName ? `贴纸包链接：t.me/addstickers/${escape(config.stickerSetShortName)}\n` : "") +
          `配置文件路径：<code>${escape(ctx.files.dataPath("config.json"))}</code>\n` +
          `<code>${escape(prefix)}yvlu config sticker 贴纸包名称</code>`, true);
        return;    })},
    s: {description: "保存回复的贴纸或图片到配置的贴纸包", args: "", handle: guarded(async (invocation, ctx, edit) => {
      const {message} = invocation;
      const config = await store(ctx).read(ctx.signal);
      const created = await saveSticker(ctx, message, config.stickerSetShortName);
      await edit(feedback("success", created ? "贴纸包已创建" : "贴纸已添加", `贴纸包：t.me/addstickers/${config.stickerSetShortName}`), true);
      return;
        })},
    r: {description: "生成语录并包含被引用内容", args: "[消息数]", alternates: [{args: "webp|image|png|stories [消息数]", description: "指定输出格式并包含回复"}], examples: [{args: "r image 3"}], handle: quote},
    f: {description: "使用指定文本生成语录", args: "文本", examples: [{args: "f 今天心情很好"}], handle: quote},
    fr: {description: "使用指定文本并包含回复内容", args: "文本", handle: quote},
    u: {description: "使用指定发送者生成语录", args: "用户ID或用户名 [消息数]", handle: quote},
    ur: {description: "使用指定发送者并包含回复内容", args: "用户ID或用户名 [消息数]", handle: quote},
    webp: {description: "生成静态 WebP 贴纸（默认）", args: "[消息数]", handle: quote},
    image: {description: "生成背景 PNG 图片", aliases: ["png"], args: "[消息数]", handle: quote},
    stories: {description: "生成故事模式 720×1280 PNG", args: "[消息数]", handle: quote},
  },
  help: [{heading: "引用与数量：", body: "回复消息生成语录，默认 1 条，最多 5 条；支持选取部分引用。f/fr 保留文本中的换行和格式实体。u/ur 可用用户 ID 或用户名指定显示发送者。"},
    {heading: "保存与配置：", body: "先用 config sticker 配置贴纸包，再回复贴纸或图片使用 s 收藏；包不存在时自动创建，需要当前账号具备贴纸包操作权限。"}],
  handle: quote,
};
const help = (prefix: string) => renderCommandHelp("yvlu", command, {prefix, title: "💬 文字语录贴纸"});

export default function createYvlu() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "yvlu", description: "生成文字语录贴纸、图片与故事，管理贴纸包", renderHelp: help,
    commands: {yvlu: command},
  });
}
