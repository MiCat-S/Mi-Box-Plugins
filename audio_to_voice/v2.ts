import {renderHelp as renderPluginHelp} from "./v2/help";
import {access, lstat, open, type FileHandle} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes, TelegramClient} from "teleproto";

const FFMPEG_PATHS = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

type AudioDocument = {
  readonly className?: unknown;
  readonly mimeType?: unknown;
  readonly size?: unknown;
  readonly attributes?: readonly unknown[];
};

type AudioSource = {
  readonly message: ApiTypes.Message;
  readonly document: AudioDocument;
  readonly commandMessage: boolean;
};

async function ffmpeg(): Promise<string> {
  for (const candidate of FFMPEG_PATHS) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error("FFmpeg unavailable");
}

function audioDocument(raw: ApiTypes.Message | undefined): AudioDocument | undefined {
  const media = raw?.media as {className?: unknown; document?: unknown} | undefined;
  if (!media) return;
  const protocolDocument = media.className === "MessageMediaDocument" &&
    (media.document as AudioDocument | undefined)?.className === "Document"
    ? media.document as AudioDocument : undefined;
  const document = protocolDocument ?? (raw as ApiTypes.Message & {document?: AudioDocument}).document;
  if (!document) return;
  const mime = document.mimeType;
  if (typeof mime === "string" && mime.startsWith("audio/")) return document;
  return (document.attributes ?? []).some(attribute => {
    const audio = attribute as {className?: unknown; voice?: unknown};
    return audio.className === "DocumentAttributeAudio" && audio.voice !== true;
  }) ? document : undefined;
}

function audioDuration(document: AudioDocument): number {
  const attribute = (document.attributes ?? []).find(candidate =>
    (candidate as {className?: unknown}).className === "DocumentAttributeAudio") as {duration?: unknown} | undefined;
  return typeof attribute?.duration === "number" ? Math.max(0, Math.floor(attribute.duration)) : 0;
}

async function findAudio(message: MessageEnvelope, context: PluginContext): Promise<AudioSource | undefined> {
  if (message.replyToId !== undefined) {
    const reply = await context.telegram.getReply(message);
    const raw = reply?.raw as ApiTypes.Message | undefined;
    const document = audioDocument(raw);
    if (raw && document) return {message: raw, document, commandMessage: false};
  }
  const raw = message.raw as ApiTypes.Message | undefined;
  const document = audioDocument(raw);
  return raw && document ? {message: raw, document, commandMessage: true} : undefined;
}

function exceedsDeclaredLimit(document: AudioDocument): boolean {
  const size = String(document.size ?? "");
  return /^\d+$/.test(size) && BigInt(size) > BigInt(MAX_AUDIO_BYTES);
}

export function ffmpegArguments(input: string, output: string): string[] {
  return ["-nostdin", "-y", "-i", input, "-vn", "-acodec", "libopus", "-b:a", "64k", "-ar", "48000", "-ac", "1", output];
}

export async function writeAll(file: Pick<FileHandle, "write">, chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    signal?.throwIfAborted();
    const {bytesWritten} = await file.write(chunk, offset, chunk.byteLength - offset, null);
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw new Error("Audio input write failed");
    offset += bytesWritten;
  }
}

export async function downloadBounded(
  client: Pick<TelegramClient, "iterDownload">,
  media: Parameters<TelegramClient["iterDownload"]>[0],
  output: string,
  signal: AbortSignal,
  maxBytes = MAX_AUDIO_BYTES,
): Promise<void> {
  signal.throwIfAborted();
  const file = await open(output, "wx", 0o600);
  let total = 0;
  try {
    for await (const chunk of client.iterDownload(media, {signal})) {
      signal.throwIfAborted();
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error("Audio input too large");
      await writeAll(file, chunk, signal);
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    if (!total) throw new Error("Empty audio input");
  } finally {
    await file.close();
  }
}

async function removeReceipt(context: PluginContext, message: MessageEnvelope, commandMessage: boolean): Promise<void> {
  try {
    context.signal.throwIfAborted();
    if (commandMessage) {
      await context.telegram.edit(message, "");
      return;
    }
    const raw = message.raw as {delete?: (options: {revoke: boolean}) => Promise<unknown>} | undefined;
    if (typeof raw?.delete !== "function") return;
    await context.telegram.withClient(async (_client, signal) => {
      signal.throwIfAborted();
      await raw.delete!({revoke: true});
      signal.throwIfAborted();
    });
  } catch {
    if (!context.signal.aborted) context.log.info("audio_to_voice_receipt_cleanup_failed");
  }
}

export default function createAudioToVoice(dependencies: {readonly resolveFfmpeg?: () => Promise<string>} = {}) {
  const resolveFfmpeg = dependencies.resolveFfmpeg ?? ffmpeg;
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "audio_to_voice", description: "使用 FFmpeg 将回复音频转换为 Telegram 语音",
    resources: {processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 180_000, maxOutputBytes: 256 * 1024}},
    commands: {audio_to_voice: {helpArgs: ["help", "h"], description: "将回复音频转换为 Telegram 语音", async handle(invocation, context) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
        await context.telegram.edit(invocation.message,
          `<b>音频转语音</b>\n回复音乐文件后发送 <code>${invocation.prefix}audio_to_voice</code>\n服务器需要安装 FFmpeg。`,
          {parseMode: "html"});
        return;
      }
      try {
        const source = await findAudio(invocation.message, context);
        if (!source) {
          await context.telegram.edit(invocation.message, "请回复一个音乐文件");
          return;
        }
        if (exceedsDeclaredLimit(source.document)) throw new Error("Audio input too large");
        const executable = await resolveFfmpeg();
        await context.telegram.edit(invocation.message, "正在转换音频…");
        await context.files.withTemp(async (directory, signal) => {
          const input = path.join(directory, "input-audio");
          const output = path.join(directory, "voice.ogg");
          await context.telegram.withClient(async (client, clientSignal) => {
            const activeSignal = AbortSignal.any([signal, clientSignal]);
            await downloadBounded(client, source.message.media! as Parameters<TelegramClient["iterDownload"]>[0], input, activeSignal);
          });
          signal.throwIfAborted();
          await context.processes.run(executable, ffmpegArguments(input, output),
            {signal, timeoutMs: 180_000, maxOutputBytes: 256 * 1024});
          signal.throwIfAborted();
          const outputStat = await lstat(output);
          if (!outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.size === 0 || outputStat.size > MAX_AUDIO_BYTES) {
            throw new Error("Invalid output");
          }
          signal.throwIfAborted();
          await context.telegram.withClient(async (client, clientSignal) => {
            const activeSignal = AbortSignal.any([signal, clientSignal]);
            activeSignal.throwIfAborted();
            const {Api} = await import("teleproto");
            activeSignal.throwIfAborted();
            const raw = invocation.message.raw as ApiTypes.Message | undefined;
            if (!raw?.peerId) throw new Error("Missing peer");
            await client.sendFile(raw.peerId, {
              file: output,
              replyTo: source.commandMessage ? invocation.message.id : invocation.message.replyToId,
              forceDocument: false,
              voiceNote: true,
              attributes: [new Api.DocumentAttributeAudio({
                duration: audioDuration(source.document), voice: true, waveform: Buffer.alloc(0),
              })],
            });
            activeSignal.throwIfAborted();
          });
        });
        await removeReceipt(context, invocation.message, source.commandMessage);
      } catch {
        if (context.signal.aborted) return;
        context.log.error("audio_to_voice_failed");
        await context.telegram.edit(invocation.message, "音频转换失败，请确认回复的是音频且服务器已安装 FFmpeg");
      }
    }}},
  });
}
