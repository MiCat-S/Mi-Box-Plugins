import {access, writeFile} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin, type PluginContext} from "telebox/sdk";
import type {Api} from "teleproto";

const QR_ENCODE = ["/usr/bin/qrencode", "/usr/local/bin/qrencode", "/opt/homebrew/bin/qrencode"] as const;
const ZBAR = ["/usr/bin/zbarimg", "/usr/local/bin/zbarimg", "/opt/homebrew/bin/zbarimg"] as const;
const MAX_INPUT_BYTES = 4_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

async function runFirst(context: PluginContext, commands: readonly string[], args: readonly string[], options: Record<string, unknown>) {
  for (const command of commands) {
    try { return await context.processes.run(command, args, options); }
    catch (error) {
      context.signal.throwIfAborted();
      if ((error as {code?: unknown})?.code !== "SPAWN_FAILED") throw error;
      try { await access(command, constants.F_OK); } catch { continue; }
      throw error;
    }
  }
  throw new Error("Helper unavailable");
}

async function generate(context: PluginContext, input: string): Promise<Buffer> {
  if (!input.trim() || Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error("Invalid input");
  const result = await runFirst(context, QR_ENCODE, ["-o", "-", "-s", "6", "-m", "2", "--", input],
    {timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024});
  if (!result.stdout.length || result.stdout.length > 2 * 1024 * 1024) throw new Error("Invalid image");
  return result.stdout;
}

async function decode(context: PluginContext, image: Buffer): Promise<string[]> {
  if (!image.length || image.length > MAX_IMAGE_BYTES) throw new Error("Invalid image");
  return context.files.withTemp(async (directory, signal) => {
    const file = path.join(directory, "source-image");
    await writeFile(file, image, {mode: 0o600, signal});
    const result = await runFirst(context, ZBAR, ["--quiet", "--raw", file], {
      signal, timeoutMs: 30_000, maxOutputBytes: 64 * 1024,
      env: {LANG: "C.UTF-8", LC_ALL: "C.UTF-8"},
    });
    return result.stdout.toString("utf8").split("\n").map(value => value.endsWith("\r") ? value.slice(0, -1) : value)
      .filter(value => value.length > 0).slice(0, 20);
  });
}

function resultPages(values: readonly string[]): string[] {
  const blocks: string[] = [];
  for (const value of values) {
    let chunk = "";
    for (const character of value) {
      const encoded = escape(character);
      if (chunk && chunk.length + encoded.length > 3300) { blocks.push(`<code>${chunk}</code>`); chunk = ""; }
      chunk += encoded;
    }
    blocks.push(`<code>${chunk}</code>`);
  }
  const pages: string[] = [];
  let page = "<b>二维码内容</b>";
  for (const block of blocks) {
    if (page.length + block.length + 2 > 3500) { pages.push(page); page = ""; }
    page += `${page ? "\n\n" : ""}${block}`;
  }
  if (page) pages.push(page);
  return pages;
}

async function download(context: PluginContext, source: Api.Message): Promise<Buffer> {
  if (Number(source.document?.size ?? 0) > MAX_IMAGE_BYTES) throw new Error("Invalid image");
  return context.telegram.withClient(async (client: any, signal) => {
    if (typeof client.iterDownload !== "function") {
      const value = await client.downloadMedia(source.media!, {outputFile: Buffer.alloc(0), signal, progressCallback(received: any) {
        signal.throwIfAborted(); if (typeof received?.greater === "function" && received.greater(MAX_IMAGE_BYTES)) throw new Error("Invalid image");
      }});
      if (!Buffer.isBuffer(value) || !value.length || value.length > MAX_IMAGE_BYTES) throw new Error("Invalid image");
      return value;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of client.iterDownload(source.media!, {})) {
      signal.throwIfAborted(); total += chunk.length;
      if (total > MAX_IMAGE_BYTES) throw new Error("Invalid image");
      chunks.push(Buffer.from(chunk));
    }
    if (!total) throw new Error("Invalid image");
    return Buffer.concat(chunks, total);
  });
}

function media(raw: Api.Message | undefined): boolean {
  return Boolean(raw?.photo || raw?.sticker || raw?.document || raw?.media);
}

async function sendQr(context: PluginContext, invocation: any, input: string): Promise<void> {
  await context.telegram.edit(invocation.message, "正在生成二维码…");
  const image = await generate(context, input);
  await context.telegram.withClient(async client => {
    const {CustomFile} = await import("teleproto/client/uploads.js");
    const raw = invocation.message.raw as Api.Message | undefined;
    if (!raw?.peerId) throw new Error("Missing peer");
    await client.sendFile(raw.peerId, {file: new CustomFile("qrcode.png", image.length, "", image),
      caption: "二维码生成完成", replyTo: invocation.message.replyToId ?? invocation.message.id});
    if (typeof raw.delete === "function") {
      try { await raw.delete({revoke: true}); }
      catch { context.log.error("qr_command_cleanup_failed"); }
    }
  });
}

export default function createQr() {
  const command: CommandDefinition = {"args":"[文本]","examples":[{"args":"Hello World"},{"args":"","description":"回复文本生成二维码；回复图片识别二维码，也可读取命令消息中的图片"}],"help":[{"heading":"功能与限制：","body":"生成 PNG 二维码，输入最多 4000 字节；识别图片上限 20 MiB，一次最多返回 20 条内容。生成成功后删除命令消息。"},{"heading":"系统依赖：","body":"需要 qrencode 与 zbarimg。macOS：<code>brew install qrencode zbar</code>；Ubuntu/Debian：<code>sudo apt-get install qrencode zbar-tools</code>；CentOS/RHEL：<code>sudo yum install qrencode zbar</code>。"}],description: "生成或识别二维码", async handle(invocation, context) {
      const input = invocation.args.join(" ").trim();
      try {
        if (input) { await sendQr(context, invocation, input); return; }
        const reply = invocation.message.replyToId === undefined ? undefined : await context.telegram.getReply(invocation.message);
        const source = (media(invocation.message.raw as Api.Message | undefined) ? invocation.message : reply)?.raw as Api.Message | undefined;
        if (media(source)) {
          await context.telegram.edit(invocation.message, "正在识别二维码…");
          const image = await download(context, source!);
          const values = await decode(context, image);
          if (!values.length) await context.telegram.edit(invocation.message, "未在图片中识别到二维码");
          else for (const [index, page] of resultPages(values).entries()) {
            if (index) await context.telegram.reply(invocation.message, page, {parseMode: "html"});
            else await context.telegram.edit(invocation.message, page, {parseMode: "html"});
          }
          return;
        }
        if (reply?.text) { await sendQr(context, invocation, reply.text); return; }
        await context.telegram.edit(invocation.message,
          help(invocation.prefix),
          {parseMode: "html"});
      } catch {
        if (context.signal.aborted) return;
        context.log.error("qr_failed");
        await context.telegram.edit(invocation.message, "二维码操作失败，请确认输入有效且服务器已安装 qrencode 与 zbarimg");
      }
    }};
  const help = (prefix: string) => renderCommandHelp("qr", command, {prefix, title: "📱 QR 二维码工具"});
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "qr", description: "生成或识别二维码",
    resources: {processes: {concurrency: 1, queueCapacity: 4, timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024}}, commands: {
    qr: command,
  }});
}
