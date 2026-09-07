import {access, writeFile} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {definePlugin, type PluginContext} from "telebox/sdk";
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
    return result.stdout.toString("utf8").split(/\r?\n/).map(value => value.trim()).filter(Boolean).slice(0, 20);
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
    if (typeof raw.delete === "function") await raw.delete({revoke: true});
  });
}

export default function createQr() {
  return definePlugin({apiVersion: 1, id: "qr", description: "生成或识别二维码",
    resources: {processes: {concurrency: 1, queueCapacity: 4, timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024}}, commands: {
    qr: {description: "生成或识别二维码", async handle(invocation, context) {
      const input = invocation.args.join(" ").trim();
      try {
        if (input) { await sendQr(context, invocation, input); return; }
        const reply = invocation.message.replyToId === undefined ? undefined : await context.telegram.getReply(invocation.message);
        const source = (media(invocation.message.raw as Api.Message | undefined) ? invocation.message : reply)?.raw as Api.Message | undefined;
        if (media(source)) {
          await context.telegram.edit(invocation.message, "正在识别二维码…");
          const image = await context.telegram.withClient(async client => client.downloadMedia(source!.media!, {outputFile: Buffer.alloc(0)}) as Promise<Buffer>);
          const values = await decode(context, image);
          await context.telegram.edit(invocation.message, values.length ?
            `<b>二维码内容</b>\n\n${values.map(value => `<code>${escape(value)}</code>`).join("\n\n")}` : "未在图片中识别到二维码", values.length ? {parseMode: "html"} : {});
          return;
        }
        if (reply?.text) { await sendQr(context, invocation, reply.text); return; }
        await context.telegram.edit(invocation.message,
          `<b>二维码工具</b>\n<code>${escape(invocation.prefix)}qr 文本</code>\n也可回复文本生成，或回复图片识别。\n服务器需要安装 qrencode 与 zbarimg。`,
          {parseMode: "html"});
      } catch {
        if (context.signal.aborted) return;
        context.log.error("qr_failed");
        await context.telegram.edit(invocation.message, "二维码操作失败，请确认输入有效且服务器已安装 qrencode 与 zbarimg");
      }
    }},
  }});
}
