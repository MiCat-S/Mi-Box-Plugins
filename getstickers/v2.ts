import {renderHelp as renderPluginHelp} from "./v2/help";
import {access, appendFile, stat, unlink, writeFile} from "node:fs/promises";
import {constants, createWriteStream} from "node:fs";
import path from "node:path";
import {ZipArchive} from "archiver";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const PYTHON = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"] as const;
const MAX_STICKERS = 200;
const MAX_ITEM = 20 * 1024 * 1024;
const MAX_ARCHIVE = 1024 * 1024 * 1024;

async function helper(context: PluginContext, candidates: readonly string[], args: readonly string[], timeoutMs: number, cwd?: string) {
  for (const command of candidates) {
    try { return await context.processes.run(command, args, {cwd, timeoutMs, maxOutputBytes: 256 * 1024}); }
    catch (error) {
      context.signal.throwIfAborted();
      if ((error as {code?: unknown})?.code !== "SPAWN_FAILED") throw error;
      try { await access(command, constants.F_OK); } catch { continue; }
      throw error;
    }
  }
  throw new Error("Helper unavailable");
}

function stickerSet(document: any, Api: any): any | undefined {
  const attribute = (document?.attributes ?? []).find((entry: any) => entry instanceof Api.DocumentAttributeSticker);
  const set = attribute?.stickerset;
  if (set instanceof Api.InputStickerSetShortName && set.shortName) return new Api.InputStickerSetShortName({shortName: set.shortName});
  const id = set?.id ?? set?._id; const accessHash = set?.accessHash ?? set?.access_hash;
  if (id !== undefined && accessHash !== undefined) return new Api.InputStickerSetID({id, accessHash});
}

function stickerDocument(source: any, Api: any): any | undefined {
  const media = source?.media;
  const document = source?.sticker ?? source?.document ?? media?.document ?? (media instanceof Api.Document ? media : undefined);
  if (document instanceof Api.Document) return document;
}

function extension(document: any, Api: any): "webp" | "tgs" | "mp4" {
  const attribute = (document?.attributes ?? []).find((entry: any) => entry instanceof Api.DocumentAttributeSticker);
  if (attribute?.video || document?.mimeType === "video/webm" || document?.mimeType === "video/mp4") return "mp4";
  if (attribute?.animated || document?.mimeType === "application/x-tgsticker") return "tgs";
  return "webp";
}

async function convert(context: PluginContext, input: string, output: string, kind: "webp" | "tgs" | "mp4", directory: string): Promise<boolean> {
  try {
    if (kind === "tgs") {
      const script = path.join(directory, "tgs-to-gif.py");
      await writeFile(script, "import sys\nfrom lottie.exporters.gif import export_gif\nfrom lottie.parsers.tgs import parse_tgs\na=parse_tgs(sys.argv[1])\nexport_gif(a,sys.argv[2],512,512,30)\n", {mode: 0o600});
      await helper(context, PYTHON, [script, input, output], 120_000); return true;
    }
    const filter = kind === "mp4" ? "fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0" :
      "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0";
    await helper(context, FFMPEG, ["-nostdin", "-y", "-i", input, "-vf", filter, ...(kind === "webp" ? ["-loop", "0"] : []), output], 120_000); return true;
  } catch (error) {
    if (context.signal.aborted) throw error;
    context.log.info("getstickers_conversion_skipped", {kind}); return false;
  }
}

async function createArchive(source: string, target: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const output = createWriteStream(target, {flags: "wx", mode: 0o600});
  const archive = new ZipArchive({zlib: {level: 9}});
  let resolveTerminal!: () => void;
  let rejectTerminal!: (error: unknown) => void;
  let resolveArchiveStopped!: () => void;
  let resolveOutputStopped!: () => void;
  let archiveFinalized = false;
  let outputClosed = false;
  let settled = false;
  const terminal = new Promise<void>((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject; });
  const archiveStopped = new Promise<void>(resolve => { resolveArchiveStopped = resolve; });
  const outputStopped = new Promise<void>(resolve => { resolveOutputStopped = resolve; });
  const complete = () => {
    if (!settled && archiveFinalized && outputClosed) { settled = true; resolveTerminal(); }
  };
  const fail = (error: unknown) => {
    if (!settled) { settled = true; rejectTerminal(error); }
  };
  const stop = () => {
    archive.abort();
    archive.unpipe(output);
    archive.destroy();
    output.destroy();
  };
  const onArchiveError = (error: unknown) => fail(error);
  const onArchiveClose = () => resolveArchiveStopped();
  const onOutputError = (error: unknown) => fail(error);
  const onOutputClose = () => { outputClosed = true; resolveOutputStopped(); complete(); };
  const onAbort = () => {
    fail(signal.reason instanceof Error ? signal.reason : new Error("Archive cancelled"));
    stop();
  };
  archive.on("error", onArchiveError);
  archive.on("warning", onArchiveError);
  archive.once("close", onArchiveClose);
  output.on("error", onOutputError);
  output.once("close", onOutputClose);
  signal.addEventListener("abort", onAbort, {once: true});
  try {
    signal.throwIfAborted();
    archive.pipe(output);
    archive.directory(source, false);
    const finalized = archive.finalize();
    void finalized.then(() => { archiveFinalized = true; complete(); }, fail);
    await terminal;
    signal.throwIfAborted();
  } catch (error) {
    stop();
    await Promise.all([archiveStopped, outputStopped]);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    archive.removeListener("error", onArchiveError);
    archive.removeListener("warning", onArchiveError);
    archive.removeListener("close", onArchiveClose);
    output.removeListener("error", onOutputError);
    output.removeListener("close", onOutputClose);
  }
}

function help(prefix: string): string { return `回复贴纸后发送 <code>${prefix.replace(/[&<>]/g, "") }getstickers</code>，将整包转换并打包为 ZIP`; }

export default function createGetStickers() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "getstickers", description: "下载并打包整个贴纸包",
    resources: {processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 180_000, maxOutputBytes: 256 * 1024}}, commands: {
      getstickers: {description: "下载回复贴纸所属的贴纸包", async handle(invocation, context) {
        try {
          const reply = invocation.message.replyToId === undefined ? undefined : await context.telegram.getReply(invocation.message);
          const source = (reply?.raw ?? invocation.message.raw) as ApiTypes.Message | undefined;
          await context.telegram.withClient(async client => {
            const {Api} = await import("teleproto");
            const document = stickerDocument(source, Api);
            if (!document) {await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});return;}
            const inputSet = stickerSet(document, Api);
            if (!inputSet) throw new Error("Sticker set required");
            const result: any = await client.invoke(new Api.messages.GetStickerSet({stickerset: inputSet, hash: 0}));
            const documents = Array.isArray(result?.documents) ? result.documents : [];
            if (!documents.length || documents.length > MAX_STICKERS) throw new Error("Invalid sticker count");
            const name = String(result?.set?.shortName ?? "stickers").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64) || "stickers";
            await context.telegram.edit(invocation.message, `正在下载 ${documents.length} 张贴纸…`);
            await context.files.withTemp(async (directory, signal) => {
              const pack = path.join(directory, "pack");
              const packFile = path.join(pack, "pack.txt");
              await import("node:fs/promises").then(fs => fs.mkdir(pack, {recursive: true, mode: 0o700}));
              const emojiById = new Map<string, string>();
              for (const item of result?.packs ?? []) for (const id of item?.documents ?? []) emojiById.set(String(id), String(item?.emoticon ?? ""));
              for (let index = 0; index < documents.length; index++) {
                signal.throwIfAborted(); const item: any = documents[index]; const kind = extension(item, Api);
                const stem = String(index).padStart(3, "0"); const sourceFile = path.join(pack, `${stem}.${kind}`);
                await client.downloadFile(new Api.InputDocumentFileLocation({id: item.id, accessHash: item.accessHash,
                  fileReference: item.fileReference ?? Buffer.alloc(0), thumbSize: ""}), {outputFile: sourceFile});
                const sourceInfo = await stat(sourceFile); if (!sourceInfo.isFile() || !sourceInfo.size || sourceInfo.size > MAX_ITEM) throw new Error("Sticker too large");
                const converted = path.join(pack, `${stem}.gif`); const ok = await convert(context, sourceFile, converted, kind, directory);
                if (ok) {const convertedInfo=await stat(converted);if(!convertedInfo.isFile()||!convertedInfo.size||convertedInfo.size>MAX_ITEM)throw new Error("Converted sticker too large");await unlink(sourceFile);}
                const finalName = ok ? `${stem}.gif` : `${stem}.${kind}`;
                await appendFile(packFile, JSON.stringify({image_file: finalName, emojis: emojiById.get(String(item.id)) ?? ""}) + "\n", {encoding: "utf8", mode: 0o600});
                if (index === 0 || (index + 1) % 10 === 0 || index + 1 === documents.length) await context.telegram.edit(invocation.message, `正在下载 ${documents.length} 张贴纸… ${index + 1}/${documents.length}`);
              }
              const archive = path.join(directory, `${name}.zip`);
              await createArchive(pack, archive, signal);
              const info = await stat(archive); if (!info.isFile() || !info.size || info.size > MAX_ARCHIVE) throw new Error("Invalid archive");
              const raw = invocation.message.raw as ApiTypes.Message | undefined;
              if (!raw?.peerId) throw new Error("Missing peer");
              await client.sendFile(raw.peerId, {file: archive, caption: name, replyTo: invocation.message.replyToId, forceDocument: true});
              if (typeof raw.delete === "function") await raw.delete({revoke: true});
            });
          });
        } catch {
          if (context.signal.aborted) return;
          context.log.error("getstickers_failed");
          await context.telegram.edit(invocation.message, "贴纸包下载失败，请确认消息包含属于贴纸包的贴纸");
        }
      }},
    }});
}
