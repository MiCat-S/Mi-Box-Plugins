import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, ui, type MessageEnvelope, type PluginContext } from "telebox/sdk";
import path from "node:path";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { returnBigInt } from "teleproto/Helpers";

type UserConfig = { target: string; showSource: boolean };
type Data = { schemaVersion: 1; users: Record<string, UserConfig> };
type Link = { chatId: string; messageId: number };
const defaults: Data = { schemaVersion: 1, users: {} };
const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[c]!,
  );
const err = (value: unknown) => (value instanceof Error ? value.message : String(value));
class UserError extends Error {}
const database = (ctx: PluginContext) => ctx.storage.json<Data>("config.json", defaults);

function parseLink(value: string): Link | undefined {
  const clean = value.split("?")[0];
  const match = clean.match(/^(?:https?:\/\/)?t\.me\/(?:c\/(-?\d+)|([A-Za-z0-9_]+))\/(\d+)\/?$/);
  if (!match) return;
  let chatId = match[1] || match[2];
  if (match[1]) chatId = `-100${chatId.replace(/^-/, "")}`;
  const messageId = Number(match[3]);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return;
  return { chatId, messageId };
}
function linkFor(chatId: string, messageId: number) {
  if (/^-100\d+$/.test(chatId)) return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
  return `https://t.me/${chatId}/${messageId}`;
}
function safeName(value: string, fallback: string) {
  return (
    value
      .normalize("NFC")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 120) || fallback
  );
}
function userId(message: MessageEnvelope) {
  return message.senderId || "self";
}
const migrationChecked = new WeakSet<object>();
async function migrateLegacyConfig(ctx: PluginContext) {
  if (migrationChecked.has(ctx as object)) return;
  const current = await database(ctx).read();
  if (Object.keys(current.users || {}).length || typeof ctx.files.dataPath !== "function") {
    migrationChecked.add(ctx as object);
    return;
  }
  const legacy = path.resolve(ctx.files.dataPath(), "..", "prometheus", "config.json");
  try {
    const info = await lstat(legacy);
    ctx.signal.throwIfAborted();
    if (!info.isFile() || info.isSymbolicLink()) {
      migrationChecked.add(ctx as object);
      return;
    }
    const parsed: unknown = JSON.parse(await readFile(legacy, { encoding: "utf8", signal: ctx.signal }));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("users" in parsed) ||
      !(parsed as any).users ||
      typeof (parsed as any).users !== "object" ||
      Array.isArray((parsed as any).users)
    )
      throw new Error("Invalid legacy config");
    const users: Record<string, UserConfig> = {};
    for (const [id, value] of Object.entries((parsed as any).users as Record<string, any>)) {
      if (value && typeof value.target === "string")
        users[String(id)] = { target: value.target, showSource: value.showSource === true };
    }
    ctx.signal.throwIfAborted();
    if (Object.keys(users).length)
      await database(ctx).update(data => ({ ...data, schemaVersion: 1, users: { ...users, ...data.users } }));
    migrationChecked.add(ctx as object);
  } catch (error) {
    ctx.signal.throwIfAborted();
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      migrationChecked.add(ctx as object);
      return;
    }
    ctx.log.error("save.legacy_config_migration_failed");
    throw new Error("旧配置迁移失败");
  }
}
async function config(ctx: PluginContext, id: string) {
  await migrateLegacyConfig(ctx);
  const data = await database(ctx).read();
  return data.users[id] || { target: "me", showSource: false };
}
async function setConfig(ctx: PluginContext, id: string, patch: Partial<UserConfig>) {
  await migrateLegacyConfig(ctx);
  await database(ctx).update(data => ({
    ...data,
    schemaVersion: 1,
    users: {
      ...data.users,
      [id]: { target: data.users[id]?.target || "me", showSource: data.users[id]?.showSource ?? false, ...patch },
    },
  }));
}
async function sourceMessage(ctx: PluginContext, value: Link) {
  return ctx.telegram.withClient(async (client: any, signal) => {
    signal.throwIfAborted();
    const peer = await client.getInputEntity(/^-?\d+$/.test(value.chatId) ? returnBigInt(value.chatId) : value.chatId);
    signal.throwIfAborted();
    const messages: any[] = await client.getMessages(peer, { ids: [value.messageId] });
    signal.throwIfAborted();
    return messages[0] ? { message: messages[0], peer } : undefined;
  });
}
function mediaName(message: any) {
  const document = message?.media?.document;
  const named = document?.attributes?.find((item: any) => item?.className === "DocumentAttributeFilename")?.fileName;
  const mime = String(document?.mimeType || "");
  const ext = named
    ? path.extname(named)
    : mime.includes("jpeg")
      ? ".jpg"
      : mime.includes("png")
        ? ".png"
        : mime.includes("webp")
          ? ".webp"
          : mime.includes("mp4")
            ? ".mp4"
            : mime.includes("ogg")
              ? ".ogg"
              : mime.includes("mpeg")
                ? ".mp3"
                : ".bin";
  return safeName(named || `message_${message.id}${ext}`, `message_${message.id}.bin`);
}
const maxMediaBytes = 2 * 1024 * 1024 * 1024;
async function writeAll(file: Awaited<ReturnType<typeof open>>, chunk: Uint8Array, signal: AbortSignal) {
  let offset = 0;
  while (offset < chunk.length) {
    signal.throwIfAborted();
    const result = await file.write(chunk, offset, chunk.length - offset);
    signal.throwIfAborted();
    if (result.bytesWritten <= 0) throw new Error("媒体写入失败");
    offset += result.bytesWritten;
  }
}
async function withBusinessTemp<T>(
  ctx: PluginContext,
  operation: string,
  use: (directory: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let completed = false,
    value: T | undefined;
  try {
    return await ctx.files.withTemp(async (directory, signal) => {
      value = await use(directory, signal);
      completed = true;
      return value;
    });
  } catch (error) {
    if (ctx.signal.aborted || !completed) throw error;
    ctx.log.error("save_temp_cleanup_failed", { operation });
    return value as T;
  }
}
async function downloadTo(ctx: PluginContext, message: any, target: string): Promise<number> {
  return ctx.telegram.withClient(async (client: any, signal) => {
    const file = await open(target, "wx");
    let size = 0;
    try {
      for await (const chunk of client.iterDownload(message.media, { signal })) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > maxMediaBytes) throw new Error("媒体超过 2 GiB 上限");
        await writeAll(file, chunk, signal);
      }
      if (!size) throw new Error("下载媒体失败");
      return size;
    } finally {
      await file.close();
    }
  });
}
async function publishExclusive(source: string, directory: string, name: string) {
  const parsed = path.parse(name);
  for (let index = 0; ; index++) {
    const target = path.join(directory, `${parsed.name}${index ? `_${index}` : ""}${parsed.ext}`);
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
}

async function saveLocal(ctx: PluginContext, source: any, info: Link) {
  if (!source.media) return { ok: false, skipped: true };
  const root = await ctx.files.dataDirectory("saved");
  const chat = path.join(root, safeName(info.chatId, "chat"));
  await mkdir(chat, { recursive: true });
  const base = mediaName(source);
  let target = "",
    size = 0;
  await withBusinessTemp(ctx, "local", async directory => {
    const temporary = path.join(directory, base);
    size = await downloadTo(ctx, source, temporary);
    target = await publishExclusive(temporary, chat, `msg_${info.messageId}_${base}`);
  });
  const metadata = `${target}.json`;
  try {
    await writeFile(
      metadata,
      JSON.stringify(
        {
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          source: { chatId: info.chatId, messageId: info.messageId, link: linkFor(info.chatId, info.messageId) },
          media: {
            fileName: path.basename(target),
            mimeType: source.media?.document?.mimeType || null,
            fileSize: size,
          },
        },
        null,
        2,
      ),
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    await unlink(target).catch(() => undefined);
    throw error;
  }
  return { ok: true, file: path.relative(root, target), metadata: path.relative(root, metadata) };
}
async function forward(ctx: PluginContext, source: any, sourcePeer: any, target: any) {
  return ctx.telegram.withClient(async (client: any, signal) => {
    signal.throwIfAborted();
    try {
      const result: any[] = await client.forwardMessages(target, {
        messages: [source.id],
        fromPeer: source.peerId || sourcePeer,
      });
      signal.throwIfAborted();
      return result[0];
    } catch (error) {
      signal.throwIfAborted();
      if (!/SAVE|FORWARD|CHAT_FORWARDS_RESTRICTED/i.test(err(error))) throw error;
      if (!source.media) {
        if (!source.text) throw new Error("消息无内容可保存");
        const sent = await client.sendMessage(target, { message: source.text, formattingEntities: source.entities });
        signal.throwIfAborted();
        return sent;
      }
      return withBusinessTemp(ctx, "upload", async directory => {
        const file = path.join(directory, mediaName(source));
        await downloadTo(ctx, source, file);
        signal.throwIfAborted();
        const sent = await client.sendFile(target, {
          file,
          forceDocument: false,
          ...(source.text ? { caption: source.text, formattingEntities: source.entities } : {}),
        });
        signal.throwIfAborted();
        return sent;
      });
    }
  });
}
async function sourceNotice(ctx: PluginContext, target: any, last: any, sources: Link[]) {
  if (!last || !sources.length) return;
  const unique = [...new Map(sources.map(item => [`${item.chatId}:${item.messageId}`, item])).values()];
  const body = unique
    .map(
      item =>
        `• <a href="${escape(linkFor(item.chatId, item.messageId))}">${escape(item.chatId)} / ${item.messageId}</a>`,
    )
    .join("\n");
  try {
    const raw = `🔗 <b>消息来源</b>\n${body}`,
      rendered = await ui.renderRichText(raw, ui.PAGE_LABEL_RESERVE),
      pages = rendered.map((page, index, all) => page + ui.pageLabel(index, all.length));
    await ctx.telegram.withClient(async (client: any, signal) => {
      const delivery = await ui.deliverPages(pages, signal, async page => {
        await client.sendMessage(target, { message: page, parseMode: "html", replyTo: last.id });
      });
      if (delivery.interrupted) {
        ctx.log.error("save_source_notice_delivery_interrupted", {
          published: delivery.published,
          total: delivery.total,
          category: ui.deliveryErrorCategory(delivery.error),
        });
      }
    });
  } catch {
    ctx.signal.throwIfAborted();
    ctx.log.error("save_source_notice_failed");
  }
}

export default function createSave() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "save",
    description: "保存、转发受保护消息或将媒体写入插件数据目录",
    commands: {
      save: {
        helpArgs: ["help", "h"],
        description: "保存回复消息、消息链接或消息范围",
        async handle({ message, args, prefix }, ctx) {
          try {
            const id = userId(message),
              action = args[0]?.toLowerCase();
            if (action === "to") {
              if (!args[1]) {
                await ctx.telegram.edit(message, "❌ 请指定转发目标");
                return;
              }
              const target = args.slice(1).join(" ");
              await setConfig(ctx, id, { target });
              await ctx.telegram.edit(message, `✅ 已设置默认转发目标为: <code>${escape(target)}</code>`, {
                parseMode: "html",
              });
              return;
            }
            if (action === "target") {
              await ctx.telegram.edit(
                message,
                `📌 当前默认转发目标: <code>${escape((await config(ctx, id)).target)}</code>`,
                { parseMode: "html" },
              );
              return;
            }
            if (action === "source") {
              const current = await config(ctx, id);
              if (!args[1]) {
                await ctx.telegram.edit(
                  message,
                  `📊 来源显示功能: <b>${current.showSource ? "开启 ✅" : "关闭 ❌"}</b>`,
                  { parseMode: "html" },
                );
                return;
              }
              if (!["on", "off"].includes(args[1].toLowerCase())) {
                await ctx.telegram.edit(
                  message,
                  `❌ 无效的参数\n\n使用: <code>${escape(prefix)}save source on/off</code>`,
                  { parseMode: "html" },
                );
                return;
              }
              const showSource = args[1].toLowerCase() === "on";
              await setConfig(ctx, id, { showSource });
              await ctx.telegram.edit(message, showSource ? "✅ 已开启来源显示功能" : "❌ 已关闭来源显示功能");
              return;
            }
            if (["help", "h"].includes(action)) {
              await ctx.telegram.edit(message, renderPluginHelp(prefix), { parseMode: "html" });
              return;
            }
            const current = await config(ctx, id);
            let targetName = current.target;
            const links: Link[] = [];
            let range: Link[] | undefined;
            for (let index = 0; index < args.length; index++) {
              const token = args[index];
              if (token.includes("|")) {
                const pair = token.split("|").map(parseLink);
                if (pair.length === 2 && pair[0] && pair[1] && pair[0].chatId === pair[1].chatId) {
                  const low = Math.min(pair[0].messageId, pair[1].messageId),
                    high = Math.max(pair[0].messageId, pair[1].messageId);
                  if (high - low + 1 > 500) throw new UserError("单次范围最多保存 500 条消息");
                  range = Array.from({ length: high - low + 1 }, (_, offset) => ({
                    chatId: pair[0]!.chatId,
                    messageId: low + offset,
                  }));
                  break;
                }
              }
              const parsed = parseLink(token);
              if (parsed) links.push(parsed);
              else if (index === args.length - 1 && links.length) targetName = token;
            }
            let replied: { link: Link; message: any; peer: any } | undefined;
            if (range) links.push(...range);
            if (!links.length) {
              const reply = await ctx.telegram.getReply(message);
              if (!reply) {
                await ctx.telegram.edit(message, renderPluginHelp(prefix), { parseMode: "html" });
                return;
              }
              const link = { chatId: reply.chatId, messageId: reply.id },
                raw: any = reply.raw ?? reply,
                peer = raw.peerId ?? (/^-?\d+$/.test(reply.chatId) ? returnBigInt(reply.chatId) : reply.chatId);
              replied = { link, message: raw, peer };
              links.push(link);
            }
            const local = targetName.toLowerCase() === "local",
              target = local
                ? undefined
                : await ctx.telegram.withClient((client: any) =>
                    client.getInputEntity(/^-?\d+$/.test(targetName) ? returnBigInt(targetName) : targetName),
                  );
            let succeeded = 0,
              skipped = 0,
              failed = 0,
              last: any;
            const sources: Link[] = [];
            for (const item of links) {
              ctx.signal.throwIfAborted();
              const found =
                replied && item === replied.link
                  ? { message: replied.message, peer: replied.peer }
                  : await sourceMessage(ctx, item);
              if (!found) {
                skipped++;
                continue;
              }
              try {
                if (local) {
                  const result = await saveLocal(ctx, found.message, item);
                  result.ok ? succeeded++ : skipped++;
                } else {
                  last = await forward(ctx, found.message, found.peer, target);
                  succeeded++;
                  sources.push(item);
                }
              } catch {
                ctx.signal.throwIfAborted();
                failed++;
              }
            }
            if (!local && current.showSource) await sourceNotice(ctx, target, last, sources);
            const receipt = local
              ? `✅ 本地保存完成\n已保存: ${succeeded}\n跳过: ${skipped}\n失败: ${failed}\n目录: <code>saved/</code>`
              : `✅ 处理完成\n成功: ${succeeded}/${links.length}\n失败: ${failed}`;
            try {
              await ctx.telegram.edit(message, receipt, { parseMode: "html" });
            } catch {
              ctx.log.error("save_receipt_failed");
              return;
            }
          } catch (error) {
            if (!ctx.signal.aborted) {
              if (error instanceof UserError)
                await ctx.telegram.edit(message, `❌ ${escape(error.message)}`, { parseMode: "html" });
              else {
                ctx.log.error("save_command_failed");
                await ctx.telegram.edit(message, "❌ 执行失败，请稍后重试");
              }
            }
          }
        },
      },
    },
  });
}
