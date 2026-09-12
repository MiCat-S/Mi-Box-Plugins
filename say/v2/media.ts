import {stat, writeFile} from "node:fs/promises";
import path from "node:path";
import type {MessageEnvelope, PluginContext} from "telebox/sdk";
import type {ProviderName, SayConfig} from "./config";
import {synthesize} from "./providers";

const FFMPEG = process.platform === "win32"
  ? ["C:\\ffmpeg\\bin\\ffmpeg.exe"]
  : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"];
const providerLabel: Readonly<Record<ProviderName, string>> = {mimo: "MiMo", volc: "火山豆包", fish: "Fish"};

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[character]!);

export function cleanText(value: string): string {
  return value.replace(/\[(.+?)\]\((.*?)\)/gu, "$1")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/([，。？！、,?!.])\1+/gu, "$1").trim().slice(0, 3000);
}

export async function findFfmpeg(ctx: PluginContext): Promise<{path: string; version: string} | undefined> {
  for (const candidate of FFMPEG) {
    try {
      const result = await ctx.processes.run(candidate, ["-version"], {timeoutMs: 5_000, maxOutputBytes: 16 * 1024});
      return {path: candidate, version: result.stdout.toString("utf8").split("\n")[0]!.slice(0, 200)};
    } catch { if (ctx.signal.aborted) throw ctx.signal.reason; }
  }
  return undefined;
}

async function translate(ctx: PluginContext, text: string): Promise<string[]> {
  if (!ctx.services.available("ai", "translate")) return [];
  const targets = ["en", "ja", "ko", "zh-CN"] as const;
  const labels: Record<string, string> = {en: "🇺🇸", ja: "🇯🇵", ko: "🇰🇷", "zh-CN": "🇨🇳"};
  const values = await Promise.allSettled(targets.map(target =>
    ctx.services.call<string>("ai", "translate", {text, target}, ctx.signal)));
  return values.flatMap((value, index) => value.status === "fulfilled" && typeof value.value === "string" && value.value.trim()
    ? [`<blockquote>${labels[targets[index]!]} ${escape(value.value.trim().slice(0, 500))}</blockquote>`] : []);
}

function caption(text: string, translations: readonly string[] = []): string {
  const original = `<blockquote>🇺🇳 ${escape(text.slice(0, 700))}</blockquote>`;
  const body = [original, ...translations].join("\n");
  return body.length <= 1000 ? body : `${body.slice(0, 999)}…`;
}

async function opus(ctx: PluginContext, directory: string, source: Buffer, extension: string): Promise<string> {
  const input = path.join(directory, `source.${extension}`); const output = path.join(directory, "voice.ogg");
  if (extension === "ogg" || extension === "opus") {
    await writeFile(output, source, {mode: 0o600, flag: "wx"}); return output;
  }
  const ffmpeg = await findFfmpeg(ctx);
  if (!ffmpeg) throw new Error("MiMo/Fish 输出需要 FFmpeg；请由系统管理员安装后重试");
  await writeFile(input, source, {mode: 0o600, flag: "wx"});
  await ctx.processes.run(ffmpeg.path, ["-nostdin", "-v", "error", "-y", "-i", input, "-vn", "-c:a", "libopus", "-b:a", "64k", "-ar", "48000", "-ac", "1", output],
    {timeoutMs: 180_000, maxOutputBytes: 256 * 1024});
  const info = await stat(output); if (!info.isFile() || !info.size || info.size > 32 * 1024 * 1024) throw new Error("FFmpeg 未生成有效语音");
  return output;
}

export async function sendVoice(ctx: PluginContext, invocation: {message: MessageEnvelope}, text: string, config: SayConfig,
  progress: (text: string) => Promise<void>): Promise<any> {
  const cleaned = cleanText(text); if (!cleaned) throw new Error("文本为空或仅包含特殊字符");
  const result = await synthesize(ctx, cleaned, config, async (provider, attempt) => {
    await progress(attempt === 1 ? `正在使用 ${providerLabel[provider]} 合成语音…` : `正在切换备用 ${providerLabel[provider]}…`);
  });
  return ctx.files.withTemp(async (directory, signal) => {
    const output = await opus(ctx, directory, result.buffer, result.extension);
    signal.throwIfAborted(); const info = await stat(output); if (!info.size) throw new Error("语音为空");
    const raw = invocation.message.raw as any; if (!raw?.peerId) throw new Error("消息上下文不可用");
    const sent = await ctx.telegram.withClient(async client => {
      const {Api} = await import("teleproto");
      return client.sendFile(raw.peerId, {file: output, voiceNote: true, forceDocument: false,
        caption: caption(text), parseMode: "html", replyTo: invocation.message.replyToId,
        attributes: [new Api.DocumentAttributeAudio({duration: 0, voice: true, title: "Say Voice", performer: providerLabel[result.provider]})]});
    });
    if (config.translate) {
      const lines = await translate(ctx, text);
      if (lines.length && sent && typeof sent.edit === "function") await sent.edit({text: caption(text, lines), parseMode: "html"});
    }
    return sent;
  });
}

export async function deleteSource(message: MessageEnvelope): Promise<void> {
  const raw = message.raw as any;
  if (typeof raw?.delete === "function") await raw.delete({revoke: true}).catch(() => undefined);
}
