import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function parse(args: readonly string[]): {name: string; title?: string; limit: number} | undefined {
  if (!args.length) return;
  let name = args[0]!;
  try {
    if (/^https?:\/\//i.test(name)) {
      const url = new URL(name);
      if (!['t.me', 'www.t.me'].includes(url.hostname.toLowerCase())) return;
      const match = url.pathname.match(/^\/addstickers\/([A-Za-z0-9_]+)\/?$/);
      if (!match) return;
      name = match[1]!;
    }
  } catch { return; }
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) return;
  let limit = 100;
  const title: string[] = [];
  for (const value of args.slice(1)) {
    const match = value.match(/^limit=(\d+)$/i);
    if (!match) title.push(value);
    else {
      const parsed = Number(match[1]);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 120) return;
      limit = parsed;
    }
  }
  const joined = title.join(" ").trim();
  if (joined.length > 64) return;
  return {name, title: joined || undefined, limit};
}

function help(prefix: string): string {
  return `<b>复制贴纸包</b>\n<code>${escape(prefix)}copy_sticker_set 贴纸包 [新标题] [limit=数量]</code>\n` +
    `贴纸包可填写短名称或 t.me/addstickers 链接，数量范围 1–120。`;
}

export default function createCopyStickerSet() {
  const command = {description: "将现有贴纸包复制到自己的账户", async handle(invocation: any, context: PluginContext) {
    const input = parse(invocation.args);
    if (!input) { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    await context.telegram.edit(invocation.message, "正在读取贴纸包…");
    try {
      await context.telegram.withClient(async client => {
        const {Api} = await import("teleproto");
        const source: any = await client.invoke(new Api.messages.GetStickerSet({
          stickerset: new Api.InputStickerSetShortName({shortName: input.name}), hash: 0,
        }));
        if (!source?.set || !Array.isArray(source.documents) || !source.documents.length) throw new Error("Invalid set");
        const selected = source.documents.slice(0, input.limit);
        const stickers = selected.flatMap((document: any) => {
          if (!(document instanceof Api.Document)) return [];
          const attribute = (document.attributes ?? []).find((value: any) => value instanceof Api.DocumentAttributeSticker);
          return [new Api.InputStickerSetItem({document: new Api.InputDocument({id: document.id,
            accessHash: document.accessHash, fileReference: document.fileReference ?? Buffer.alloc(0)}), emoji: attribute?.alt || "🙂"})];
        });
        if (!stickers.length) throw new Error("No compatible stickers");
        await context.telegram.edit(invocation.message, `正在创建贴纸包（${stickers.length}/${source.documents.length}）…`);
        const suffix = Date.now().toString(36);
        const stem = input.name.toLowerCase().replace(/_+/g, "_").slice(0, 40).replace(/^_+|_+$/g, "") || "stickers";
        const shortName = `mibox_${stem}_${suffix}`.slice(0, 64);
        await client.invoke(new Api.stickers.CreateStickerSet({userId: "me", title: input.title || `${source.set.title} (复制)`, shortName, stickers}));
        await context.telegram.edit(invocation.message,
          `<b>贴纸包复制完成</b>\n原包：${escape(source.set.title)}\n新包：${escape(input.title || `${source.set.title} (复制)`)}\n` +
          `数量：${stickers.length}\n<a href="https://t.me/addstickers/${shortName}">打开新贴纸包</a>`,
          {parseMode: "html", linkPreview: false});
      });
    } catch {
      if (context.signal.aborted) return;
      context.log.error("copy_sticker_set_failed");
      await context.telegram.edit(invocation.message, "贴纸包复制失败，请确认贴纸包存在且账户允许创建新贴纸包");
    }
  }};
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "copy_sticker_set", description: "复制 Telegram 贴纸包",
    commands: {copy_sticker_set: command, css: command}});
}
