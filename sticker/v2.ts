import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes, TelegramClient} from "teleproto";

const defaults = {schemaVersion: 1, sticker_default_pack: ""};
const tails = new Map<string, Promise<void>>();
const cursors = new Map<string, number>();
const BOT = "stickers";
const emojis = ["😀", "😁", "😂", "🤣", "😊", "🙂", "😉", "😎", "😍", "🤔"];

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;"})[character]!);

async function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  tails.set(key, current);
  await previous.catch(() => undefined);
  try { return await operation(); }
  finally { release(); if (tails.get(key) === current) tails.delete(key); }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); }
    signal.addEventListener("abort", abort, {once: true});
  });
}

async function configuration(context: PluginContext) {
  const store = context.storage.json("config.json", defaults);
  let current = await store.read();
  if (current.schemaVersion !== 1) current = await store.update(value => ({...value, schemaVersion: 1,
    sticker_default_pack: typeof value.sticker_default_pack === "string" ? value.sticker_default_pack : ""}));
  return {store, current};
}

async function latest(client: TelegramClient): Promise<any[]> {
  const values = await client.getMessages(BOT, {limit: 8});
  return Array.isArray(values) ? values : [];
}

async function waitBot(client: TelegramClient, signal: AbortSignal, after: number,
  accept: (message: any) => boolean): Promise<any> {
  for (let attempt = 0; attempt < 18; attempt++) {
    signal.throwIfAborted();
    const cursor = cursors.get(BOT) ?? 0;
    const result = (await latest(client)).slice().reverse().find(message => {
      const id = Number(message?.id ?? 0);
      return !message?.out && id > cursor && Number(message?.date ?? 0) >= after && accept(message);
    });
    if (result) { cursors.set(BOT, Number(result.id)); return result; }
    await delay(650, signal);
  }
  throw new Error("Sticker bot timeout");
}

async function addWithBot(client: TelegramClient, signal: AbortSignal, source: ApiTypes.Message,
  packName: string, emoji: string): Promise<void> {
  await serial(BOT, async () => {
    const baseline = await latest(client);
    cursors.set(BOT, Math.max(cursors.get(BOT) ?? 0, ...baseline.map(item => Number(item?.id ?? 0))));
    const started = Math.floor(Date.now() / 1000) - 1;
    try {
      await client.sendMessage(BOT, {message: "/addsticker"});
      await waitBot(client, signal, started, message => Boolean(message?.message));
      await client.sendMessage(BOT, {message: packName});
      const pack = await waitBot(client, signal, started, message => Boolean(message?.message));
      if (/invalid set/i.test(String(pack.message))) throw new Error("Invalid sticker set");
      await client.forwardMessages(BOT, {messages: [source.id], fromPeer: source.peerId});
      const response = await waitBot(client, signal, started, message => Boolean(message?.message));
      const text = String(response.message).toLowerCase();
      if (!text.includes("now send me an emoji")) {
        if (text.includes("video is too long") || text.includes("3 seconds or less")) throw new Error("Video too long");
        if (text.includes("dimensions should be")) throw new Error("Invalid dimensions");
        throw new Error("Unexpected sticker bot response");
      }
      await client.sendMessage(BOT, {message: emoji});
      await waitBot(client, signal, started, message => Boolean(message?.message));
      await client.sendMessage(BOT, {message: "/done"});
    } catch (error) {
      if (!signal.aborted) await client.sendMessage(BOT, {message: "/cancel"}).catch(() => undefined);
      throw error;
    }
  });
}

function validPack(value: string): boolean { return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value); }
function help(prefix: string): string { return `<b>贴纸收藏</b>\n回复贴纸：<code>${escape(prefix)}sticker [to 包名]</code>\n` +
  `<code>${escape(prefix)}sticker 包名</code> 设置默认包 · <code>${escape(prefix)}sticker cancel</code> 取消`; }

export default function createSticker() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "sticker", description: "收藏贴纸到自己的贴纸包", commands: {
    sticker: {helpArgs: ["help","h"], description: "收藏贴纸或配置默认贴纸包", async handle(invocation, context) {
      const args = invocation.args;
      if (["help", "h"].includes(args[0]?.toLowerCase() ?? "")) {
        await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html", linkPreview: false}); return;
      }
      try {
        const reply = invocation.message.replyToId === undefined ? undefined : await context.telegram.getReply(invocation.message);
        const rawReply = reply?.raw as ApiTypes.Message | undefined;
        const {store, current} = await configuration(context);
        if (!rawReply?.sticker) {
          if (!args.length) {
            const configured = current.sticker_default_pack;
            await context.telegram.edit(invocation.message, configured ?
              `当前默认贴纸包：<a href="https://t.me/addstickers/${escape(configured)}">${escape(configured)}</a>` : "尚未设置默认贴纸包", {parseMode: "html", linkPreview: false}); return;
          }
          if (args.length !== 1) throw new Error("Invalid arguments");
          if (args[0]!.toLowerCase() === "cancel") {
            await store.update(value => ({...value, schemaVersion: 1, sticker_default_pack: ""}));
            await context.telegram.edit(invocation.message, "已取消默认贴纸包"); return;
          }
          if (!validPack(args[0]!)) throw new Error("Invalid pack name");
          await context.telegram.withClient(async client => {
            const {Api} = await import("teleproto");
            await client.invoke(new Api.messages.GetStickerSet({stickerset: new Api.InputStickerSetShortName({shortName: args[0]!}), hash: 0}));
          });
          await store.update(value => ({...value, schemaVersion: 1, sticker_default_pack: args[0]!}));
          await context.telegram.edit(invocation.message, `默认贴纸包已设置为：<code>${escape(args[0])}</code>`, {parseMode: "html"}); return;
        }
        await context.telegram.withClient(async (client, signal) => {
          const {Api} = await import("teleproto");
          const document: any = rawReply.sticker;
          if (!(document instanceof Api.Document)) throw new Error("Invalid sticker");
          const attribute = (document.attributes ?? []).find((item: any) => item instanceof Api.DocumentAttributeSticker);
          const emoji = String(attribute?.alt ?? "").trim() || emojis[Math.floor(Math.random() * emojis.length)]!;
          const me: any = await client.getMe();
          let packName = args.length === 2 && args[0]?.toLowerCase() === "to" ? args[1]! : current.sticker_default_pack;
          if (packName && !validPack(packName)) throw new Error("Invalid pack name");
          const suffix = document.mimeType === "application/x-tgsticker" ? "animated" : document.mimeType === "video/webm" ? "video" : "static";
          let create = false;
          const inspect = async (candidate: string) => {
            try {
              const set: any = await client.invoke(new Api.messages.GetStickerSet({stickerset: new Api.InputStickerSetShortName({shortName: candidate}), hash: 0}));
              return Number(set?.set?.count ?? 0) < 120;
            } catch (error) { if ((error as any)?.errorMessage === "STICKERSET_INVALID") { create = true; return true; } throw error; }
          };
          if (packName) { if (!(await inspect(packName))) throw new Error("Sticker set full"); }
          else {
            const username = String(me?.username ?? "");
            if (!username) throw new Error("Username or default pack required");
            for (let index = 1; index <= 50; index++) { const candidate = `${username}_${suffix}_${index}`.slice(0, 64); if (await inspect(candidate)) { packName = candidate; break; } }
          }
          if (!packName) throw new Error("No sticker set available");
          if (create) {
            await client.invoke(new Api.stickers.CreateStickerSet({userId: "me", title: `@${me.username ?? "user"} 的收藏`, shortName: packName,
              stickers: [new Api.InputStickerSetItem({document: new Api.InputDocument({id: document.id, accessHash: document.accessHash,
                fileReference: document.fileReference ?? Buffer.alloc(0)}), emoji})]}));
          } else await addWithBot(client, signal, rawReply, packName, emoji);
          await context.telegram.edit(invocation.message, `贴纸已添加到 <a href="https://t.me/addstickers/${escape(packName)}">${escape(packName)}</a>`, {parseMode: "html", linkPreview: false});
        });
      } catch (error) {
        if (context.signal.aborted) return;
        context.log.error("sticker_failed", {code: String((error as any)?.errorMessage ?? (error as any)?.code ?? "FAILED").slice(0, 80)});
        await context.telegram.edit(invocation.message, "贴纸收藏失败，请检查贴纸包名称、所有权和贴纸格式");
      }
    }},
  }, cleanup() { tails.clear(); cursors.clear(); }});
}
