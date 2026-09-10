import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes, TelegramClient} from "teleproto";

const BOT = "@SeSe3000Bot";

function escape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, character =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;"})[character]!);
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(done, milliseconds);
    function done() { signal.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); }
    signal.addEventListener("abort", abort, {once: true});
  });
}

function video(message: any): boolean {
  const document = message?.document ?? message?.media?.document;
  if (message?.video || String(document?.mimeType ?? "").startsWith("video/")) return true;
  const name = (document?.attributes ?? []).find((attribute: any) => typeof attribute?.fileName === "string")?.fileName ?? "";
  return /\.(?:mp4|avi|mov|mkv|webm|flv|wmv|m4v)$/i.test(name);
}

function caption(message: any): string {
  const text = String(message?.message ?? "");
  const excluded = (message?.entities ?? []).filter((entity: any) =>
    ["MessageEntityHashtag", "MessageEntityTextUrl", "MessageEntityUrl"].includes(entity?.className))
    .map((entity: any) => ({offset: Number(entity.offset), length: Number(entity.length)}))
    .filter((range: any) => Number.isSafeInteger(range.offset) && Number.isSafeInteger(range.length) && range.offset >= 0 && range.length >= 0)
    .sort((left: any, right: any) => left.offset - right.offset);
  let output = "", cursor = 0;
  for (const range of excluded) { if (range.offset > cursor) output += text.slice(cursor, range.offset); cursor = Math.max(cursor, range.offset + range.length); }
  return (output + text.slice(cursor)).trim();
}

async function waitVideo(client: TelegramClient, after: number, signal: AbortSignal): Promise<any | undefined> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    signal.throwIfAborted();
    const messages = await client.getMessages(BOT, {limit: 8});
    const found = (Array.isArray(messages) ? messages : []).find((message: any) =>
      !message?.out && Number(message?.id ?? 0) > after && video(message));
    if (found) return found;
    if (attempt < 29) await sleep(650, signal);
  }
}

export default function createKkp() {
  let tail = Promise.resolve();
  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => undefined);
    try { return await operation(); } finally { release(); }
  };
  const command: CommandDefinition = {
    args: "", examples: [{args: ""}],
    help: [{heading: "说明：", body: "与 @SeSe3000Bot 交互获取随机视频并发送到当前对话；视频和说明使用剧透标记。请先在机器人会话点击 Start。"}],
    helpArgs: ["help","h"], description: "获取随机视频", async handle(invocation, context) {
      const sub = invocation.args[0]?.toLowerCase() ?? "";
      if (sub === "help" || sub === "h") {
        await context.telegram.edit(invocation.message,
          help(invocation.prefix), {parseMode: "html"}); return;
      }
      if (sub) { await context.telegram.edit(invocation.message, `未知参数：<code>${escape(sub)}</code>`, {parseMode: "html"}); return; }
      await context.telegram.edit(invocation.message, "正在获取随机视频…");
      try {
        await context.telegram.withClient(async (client, signal) => serialize(async () => {
          signal.throwIfAborted();
          const before = await client.getMessages(BOT, {limit: 1});
          const cursor = Number(Array.isArray(before) ? before[0]?.id ?? 0 : 0);
          if (!Array.isArray(before) || before.length === 0) {
            await client.sendMessage(BOT, {message: "/start"});
            await sleep(800, signal);
          }
          await client.sendMessage(BOT, {message: "随机色色"});
          const result = await waitVideo(client, cursor, signal);
          if (!result?.media) throw new Error("No video");
          const {Api} = await import("teleproto");
          let file: any = result.media;
          if (result.media instanceof Api.MessageMediaDocument && result.media.document instanceof Api.Document) {
            const document = result.media.document;
            file = new Api.InputMediaDocument({id: new Api.InputDocument({id: document.id,
              accessHash: document.accessHash, fileReference: document.fileReference}), spoiler: true});
          }
          const raw = invocation.message.raw as ApiTypes.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          const text = caption(result);
          await client.sendFile(raw.peerId, {file, caption: text, spoiler: true, forceDocument: false,
            formattingEntities: text ? [new Api.MessageEntitySpoiler({offset: 0, length: text.length})] : undefined,
            replyTo: invocation.message.replyToId});
          try { await client.markAsRead(BOT); } catch {}
          if (typeof raw.delete === "function") await raw.delete({revoke: true});
        }));
      } catch {
        if (context.signal.aborted) return;
        context.log.error("kkp_failed");
        await context.telegram.edit(invocation.message, "获取视频失败或超时，请确认已在机器人会话中点击 Start");
      }
    }};
  const help = (prefix: string) => renderCommandHelp("kkp", command, {prefix, title: "🎲 随机色色视频获取"});
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "kkp", description: "通过 Telegram 机器人获取随机视频",
    commands: {kkp: command},
    cleanup() { tail = Promise.resolve(); },
  });
}
