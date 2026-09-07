import {access, stat} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {definePlugin} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const FFMPEG_PATHS = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;

async function ffmpeg(): Promise<string> {
  for (const candidate of FFMPEG_PATHS) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error("FFmpeg unavailable");
}

function audioDuration(raw: ApiTypes.Message): number {
  const attributes = (raw.document as {attributes?: unknown[]} | undefined)?.attributes ?? [];
  const value = attributes.find(attribute => typeof (attribute as {duration?: unknown}).duration === "number") as {duration?: number} | undefined;
  return Math.max(0, Math.floor(value?.duration ?? 0));
}

function isAudio(raw: ApiTypes.Message | undefined): raw is ApiTypes.Message {
  if (!raw?.media || !raw.document) return false;
  const mime = (raw.document as {mimeType?: unknown}).mimeType;
  if (typeof mime === "string" && mime.startsWith("audio/")) return true;
  return ((raw.document as {attributes?: unknown[]}).attributes ?? []).some(attribute =>
    typeof (attribute as {voice?: unknown}).voice === "boolean" && !(attribute as {voice?: boolean}).voice);
}

export default function createAudioToVoice() {
  return definePlugin({apiVersion: 1, id: "audio_to_voice", description: "使用 FFmpeg 将回复音频转换为 Telegram 语音",
    resources: {processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 180_000, maxOutputBytes: 256 * 1024}},
    commands: {audio_to_voice: {description: "将回复音频转换为 Telegram 语音", async handle(invocation, context) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "") || invocation.message.replyToId === undefined) {
        await context.telegram.edit(invocation.message,
          `<b>音频转语音</b>\n回复音乐文件后发送 <code>${invocation.prefix}audio_to_voice</code>\n服务器需要安装 FFmpeg。`,
          {parseMode: "html"});
        return;
      }
      try {
        const reply = await context.telegram.getReply(invocation.message);
        const source = reply?.raw as ApiTypes.Message | undefined;
        if (!isAudio(source)) throw new Error("Audio required");
        const executable = await ffmpeg();
        await context.telegram.edit(invocation.message, "正在转换音频…");
        await context.files.withTemp(async (directory, signal) => {
          const input = path.join(directory, "input-audio");
          const output = path.join(directory, "voice.ogg");
          await context.telegram.withClient(async client => {
            await client.downloadMedia(source.media!, {outputFile: input});
          });
          signal.throwIfAborted();
          await context.processes.run(executable, [
            "-nostdin", "-y", "-i", input, "-vn", "-acodec", "libopus", "-b:a", "64k", "-ar", "48000", "-ac", "1", output,
          ], {signal, timeoutMs: 180_000, maxOutputBytes: 256 * 1024});
          const outputStat = await stat(output);
          if (!outputStat.isFile() || outputStat.size === 0 || outputStat.size > 50 * 1024 * 1024) throw new Error("Invalid output");
          await context.telegram.withClient(async client => {
            const {Api} = await import("teleproto");
            const raw = invocation.message.raw as ApiTypes.Message | undefined;
            if (!raw?.peerId) throw new Error("Missing peer");
            await client.sendFile(raw.peerId, {
              file: output, replyTo: invocation.message.replyToId, forceDocument: false, voiceNote: true,
              attributes: [new Api.DocumentAttributeAudio({duration: audioDuration(source), voice: true, waveform: Buffer.alloc(0)})],
            });
            if (typeof raw.delete === "function") await raw.delete({revoke: true});
          });
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("audio_to_voice_failed");
        await context.telegram.edit(invocation.message, "音频转换失败，请确认回复的是音频且服务器已安装 FFmpeg");
      }
    }}},
  });
}
