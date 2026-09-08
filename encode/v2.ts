import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";

const MAX_INPUT = 16_384;
const MAX_DISPLAY = 3_000;

function escape(value: string): string {
  return value.replace(/[&<>\"]/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"})[char]!);
}

const help = (prefix: string) => `<b>编码解码工具</b>\n<code>${escape(prefix)}b64encode 文本</code> Base64 编码\n<code>${escape(prefix)}b64decode 文本</code> Base64 解码\n<code>${escape(prefix)}urlencode 文本</code> URL 编码\n<code>${escape(prefix)}urldecode 文本</code> URL 解码\n也可回复消息后直接使用命令。`;

function decodeBase64(input: string): string {
  const compact = input.replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error("无效的 Base64 字符串");
  }
  const bytes = Buffer.from(compact, "base64");
  if ((compact.includes("=") && compact.length % 4 !== 0) ||
      bytes.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
    throw new Error("无效的 Base64 字符串");
  }
  try {
    return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  } catch {
    throw new Error("Base64 内容不是有效的 UTF-8 文本");
  }
}

function transform(operation: string, input: string): string {
  switch (operation) {
    case "b64encode": return Buffer.from(input, "utf8").toString("base64");
    case "b64decode": return decodeBase64(input);
    case "urlencode": return encodeURIComponent(input);
    case "urldecode":
      try { return decodeURIComponent(input); } catch { throw new Error("无效的 URL 编码字符串"); }
    default: throw new Error("不支持的操作");
  }
}

async function inputText(ctx: PluginContext, message: MessageEnvelope, args: readonly string[]): Promise<string> {
  const supplied = args.join(" ").trim();
  if (supplied) return supplied;
  const reply = await ctx.telegram.getReply(message);
  return reply?.text?.trim() ?? "";
}

export default function createEncode() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "encode", description: "Base64 与 URL 编码解码工具",
    commands: {
      encode: {helpOnEmpty: true, description: "查看编码解码帮助", async handle({message, prefix}, ctx) {
        await ctx.telegram.edit(message, help(prefix), {parseMode: "html"});
      }},
      b64encode: {description: "Base64 编码", async handle(invocation, ctx) {
        await handle(invocation, ctx, "b64encode", "Base64 编码");
      }},
      b64decode: {description: "Base64 解码", async handle(invocation, ctx) {
        await handle(invocation, ctx, "b64decode", "Base64 解码");
      }},
      urlencode: {description: "URL 编码", async handle(invocation, ctx) {
        await handle(invocation, ctx, "urlencode", "URL 编码");
      }},
      urldecode: {description: "URL 解码", async handle(invocation, ctx) {
        await handle(invocation, ctx, "urldecode", "URL 解码");
      }},
    },
  });
}

async function handle(invocation: {message: MessageEnvelope; args: readonly string[]}, ctx: PluginContext, operation: string, label: string): Promise<void> {
  ctx.signal.throwIfAborted();
  let input: string;
  try {
    input = await inputText(ctx, invocation.message, invocation.args);
  } catch {
    if (ctx.signal.aborted) return;
    await ctx.telegram.edit(invocation.message, "读取回复消息失败，请稍后重试");
    return;
  }
  ctx.signal.throwIfAborted();
  if (!input) {
    await ctx.telegram.edit(invocation.message, `<b>缺少文本内容</b>\n请提供要${operation.endsWith("decode") ? "解码" : "编码"}的文本，或回复一条消息`, {parseMode: "html"});
    return;
  }
  if (input.length > MAX_INPUT) {
    await ctx.telegram.edit(invocation.message, `<b>处理失败</b>\n输入不能超过 <code>${MAX_INPUT}</code> 个字符`, {parseMode: "html"});
    return;
  }
  let output: string;
  try {
    output = transform(operation, input);
  } catch {
    await ctx.telegram.edit(invocation.message, `<b>${label}失败</b>\n输入不是有效的${operation.startsWith("b64") ? " Base64 或 UTF-8 文本" : " URL 编码或文本"}`, {parseMode: "html"});
    return;
  }
  // Split before escaping so neither Unicode code points nor HTML entities are cut.
  const pages: string[] = [];
  let page = "";
  for (const character of output) {
    const encoded = escape(character);
    if (page.length + encoded.length > MAX_DISPLAY) { pages.push(page); page = ""; }
    page += encoded;
  }
  pages.push(page);
  for (let index = 0; index < pages.length; index++) {
    ctx.signal.throwIfAborted();
    const text = `<b>${label}完成</b>${pages.length > 1 ? ` (${index + 1}/${pages.length})` : ""}\n<code>${pages[index]}</code>`;
    if (index === 0) await ctx.telegram.edit(invocation.message, text, {parseMode: "html"});
    else await ctx.telegram.reply(invocation.message, text, {parseMode: "html"});
  }
}
