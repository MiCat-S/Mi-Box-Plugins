import {renderHelp as renderPluginHelp} from "./v2/help";
import { definePlugin, type PluginContext, type MessageEnvelope } from "telebox/sdk";
import { setTimeout as sleep } from "node:timers/promises";
import {randomUUID} from "node:crypto";
import type { TelegramClient } from "teleproto";

const defaults = { batchSize: 50, searchLimit: 100, retryAttempts: 3 };
type Config = typeof defaults;
const escape = (value: unknown) => String(value).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const help = (prefix: string) => `<b>智能防撤回删除</b>\n\n<code>${escape(prefix)}dme 数量</code> 快速删除自己的消息\n<code>${escape(prefix)}dme -f 数量</code> 替换文本和媒体后删除\n<code>${escape(prefix)}dme 999999</code> 删除全部可见的自己的消息\n普通数量单次最多 2000 条；仅处理命令之前的消息及当前话题。\n收藏夹直接删除；-f 模式下广播频道主直接按数量删除。\n防撤回编辑可能因消息类型、编辑时限或权限失败，不保证第三方副本被删除。`;

function topic(message: any): number | undefined {
  const reply = message?.replyTo;
  return [reply?.replyToTopId, reply?.topMsgId, reply?.replyToMsgId, reply?.replyToMsg?.id]
    .find(id => Number.isInteger(id) && id > 0);
}
function typedPeer(peer: any): string | undefined {
  for (const key of ["userId", "channelId", "chatId"]) {
    if (peer?.[key] !== undefined) return `${key}:${peer[key].toString()}`;
  }
  // Numeric sender IDs use Telegram's marked peer format, never an untyped raw-ID comparison.
  const value = typeof peer === "object" ? peer?.toString?.() : String(peer ?? "");
  if (/^-100\d+$/.test(value)) return `channelId:${value.slice(4)}`;
  if (/^-\d+$/.test(value)) return `chatId:${value.slice(1)}`;
  if (/^\d+$/.test(value)) return `userId:${value}`;
  return undefined;
}

async function execute(ctx: PluginContext, client: TelegramClient, signal: AbortSignal,
  message: MessageEnvelope, count: number, anti: boolean, config: Config) {
  const { Api } = await import("teleproto");
  const { returnBigInt } = await import("teleproto/Helpers.js");
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted(); const result = await fn(); signal.throwIfAborted(); return result;
  };
  const wait = (ms: number) => sleep(ms, undefined, { signal });
  const log = (event: string) => ctx.log.error(`dme:${event}`);
  const retry = async <T>(fn: () => Promise<T>, attempts = config.retryAttempts): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try { return await call(fn); }
      catch (error) {
        signal.throwIfAborted();
        if (attempt >= attempts) throw error;
        log("retry");
        const seconds = String(error).match(/FLOOD_WAIT[_ ]?(\d+)/)?.[1];
        await wait(seconds ? Number(seconds) * 1000 : 2000 * (attempt + 1));
      }
    }
  };
  const me = await call(() => client.getMe());
  const myId = me.id.toString();
  const raw = message.raw as any;
  let chat: any;
  try { chat = await retry(() => client.getEntity(raw?.peerId ?? returnBigInt(message.chatId)), 2); }
  catch (error) {
    signal.throwIfAborted(); log("entity");
    // Warm normal and archived dialogs without reinterpreting a channel ID as a user ID.
    for (const folder of [0, 1]) {
      try {
        for await (const dialog of client.iterDialogs({ folder })) {
          signal.throwIfAborted();
          if (dialog.id?.toString() === message.chatId && dialog.entity) { chat = dialog.entity; break; }
        }
      } catch { signal.throwIfAborted(); log("dialogs"); }
      if (chat) break;
    }
    if (!chat) throw new Error(`无法解析聊天实体: ${message.chatId}`);
  }
  const topicId = message.topicId ?? topic(raw);
  const saved = message.saved === true || chat.className === "InputPeerSelf" || chat.className === "PeerSelf" ||
    (chat.className === "User" && chat.id.toString() === myId) ||
    (["PeerUser", "InputPeerUser"].includes(chat.className) && chat.userId.toString() === myId);
  let direct = saved;
  if (anti && chat.className === "Channel" && chat.broadcast === true) {
    try {
      const result = await call(() => client.invoke(new Api.channels.GetParticipant({ channel: chat, participant: me.id })));
      direct = result.participant.className === "ChannelParticipantCreator";
    } catch { signal.throwIfAborted(); log("permission"); }
  }
  const identities = new Set<string>();
  if (!direct && chat.className === "Channel") {
    try {
      const result = await call(() => client.invoke(new Api.channels.GetSendAs({ peer: chat })));
      for (const item of result.peers) { const key = typedPeer(item.peer); if (key) identities.add(key); }
    } catch { signal.throwIfAborted(); log("send-as"); }
  }
  const mine = (m: any) => m.senderId?.toString() === myId || m.out === true ||
    [m.fromId, m.senderId].some(peer => { const key = typedPeer(peer); return key !== undefined && identities.has(key); });
  const eligible = (m: any) => m.className === "Message" && Number.isInteger(m.id) && m.id > 0 &&
    m.id < message.id && (topicId === undefined || topic(m) === topicId) && (direct || mine(m));

  try { await retry(() => client.deleteMessages(chat, [message.id], { revoke: true })); }
  catch { signal.throwIfAborted(); log("command-delete"); }

  let image: Buffer | undefined;
  let imageLoaded = false;
  const loadImage = async () => {
    if (imageLoaded) return image;
    imageLoaded = true;
    try {
      image = await ctx.tasks.run("dme:image", async scoped => {
        const { readFile, writeFile, rename, unlink } = await import("node:fs/promises");
        const combined = AbortSignal.any([signal, scoped]);
        const file = await ctx.files.dataFile("dme_troll_image.png");
        try { return await readFile(file, { signal: combined }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const buffer = await ctx.http.withResponse("https://raw.githubusercontent.com/TeleBoxOrg/TeleBox/main/telebox.png",
          { signal: combined }, async response => {
            if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
            return Buffer.from(await response.arrayBuffer());
          }, {redirects:{allowedHosts:["raw.githubusercontent.com"],maxRedirects:2}});
        combined.throwIfAborted();
        // Publish the cache atomically so simultaneous chats never read a partial image.
        const temporary = file + `.${message.id}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, buffer, { signal: combined }); combined.throwIfAborted(); await rename(temporary, file); }
        finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
        return buffer;
      });
    } catch { signal.throwIfAborted(); log("image"); }
    return image;
  };
  let edited = 0, failedEdits = 0, deleted = 0, matched = 0, failed = 0;
  const edit = async (m: any) => {
    if (typeof m.date === "number" && Math.floor(Date.now() / 1000) - m.date > 172800) return;
    try {
      if (!m.media && typeof m.message === "string") {
        if (m.message !== "占位符") await call(() => client.invoke(new Api.messages.EditMessage({ peer: chat, id: m.id, message: "占位符" })));
        edited++; return;
      }
      if (!m.media || m.media.className === "MessageMediaWebPage" ||
        m.media.document?.attributes?.some((a: any) => a.className === "DocumentAttributeSticker")) return;
      const buffer = await loadImage();
      if (!buffer) { failedEdits++; return; }
      const { CustomFile } = await import("teleproto/client/uploads.js");
      const file = await call(() => client.uploadFile({ file: new CustomFile("dme_troll.png", buffer.length, "", buffer), workers: 1 }));
      await call(() => client.invoke(new Api.messages.EditMessage({ peer: chat, id: m.id, message: "",
        media: new Api.InputMediaUploadedPhoto({ file }) })));
      edited++;
    } catch { signal.throwIfAborted(); failedEdits++; log("edit"); }
  };
  const deleteBatch = async (ids: number[]) => {
    let size = config.batchSize;
    for (let offset = 0; offset < ids.length;) {
      const batch = ids.slice(offset, offset + size);
      try {
        await retry(() => client.deleteMessages(chat, batch, { revoke: true }));
        deleted += batch.length; offset += batch.length; size = Math.min(100, size + 5);
        try { await call(() => client.invoke(new Api.updates.GetState())); }
        catch { signal.throwIfAborted(); log("sync"); }
      } catch (error) {
        signal.throwIfAborted(); log("delete");
        if (batch.length === 1) { failed++; offset++; } else size = Math.max(1, Math.floor(batch.length / 2));
      }
      await wait(200);
    }
  };
  const target = count === 999999 ? Infinity : Math.min(count, 2000);
  if (count > 2000 && count !== 999999) ctx.log.info("dme:limit", { requested: count, effective: target });
  let history = direct || chat.className === "Channel" || chat.noforwards === true;
  let offsetId = message.id, empty = 0;
  const seen = new Set<number>();
  const fromId = history ? undefined : await call(() => client.getInputEntity(me.id));
  while (matched < target) {
    signal.throwIfAborted();
    let page: any[];
    try {
      const limit = Math.min(100, config.searchLimit, history ? 100 : target - matched);
      const result = await retry(() => client.invoke(history
        ? new Api.messages.GetHistory({ peer: chat, offsetId, offsetDate: 0, addOffset: 0, limit,
          maxId: message.id, minId: 0, hash: returnBigInt(0) })
        : new Api.messages.Search({ peer: chat, fromId, q: "", filter: new Api.InputMessagesFilterEmpty(),
          ...(topicId !== undefined ? { topMsgId: topicId } : {}), minDate: 0, maxDate: 0,
          offsetId, addOffset: 0, limit, maxId: message.id, minId: 0, hash: returnBigInt(0) })), 2);
      page = "messages" in result ? result.messages : [];
    } catch (error) {
      signal.throwIfAborted();
      if (history) throw error;
      log("search-fallback"); history = true; offsetId = message.id; continue;
    }
    if (!page.length) {
      if (!history) { history = true; offsetId = message.id; continue; }
      break;
    }
    const next = Math.min(...page.map(m => m.id).filter(id => Number.isInteger(id) && id > 0));
    if (!Number.isFinite(next) || next >= offsetId) throw new Error("DME history cursor did not advance");
    offsetId = next;
    const batch = page.filter(m => eligible(m) && !seen.has(m.id)).sort((a, b) => b.id - a.id).slice(0, target - matched);
    if (!batch.length) {
      empty++;
      const emptyLimit = chat.className === "Channel" ? 300 : 3;
      if (history && !direct && empty >= emptyLimit) { ctx.log.info("dme:scan-limit", { emptyBatches: empty }); break; }
    } else {
      empty = 0;
      for (const m of batch) seen.add(m.id);
      // Only retain IDs from the bounded search phase for fallback deduplication.
      // Once history passes them, they can be discarded, including unlimited runs.
      matched += batch.length;
      if (anti && !direct) {
        const before = edited;
        for (const m of batch) { signal.throwIfAborted(); await edit(m); }
        if (edited > before) await wait(1000);
      }
      await deleteBatch(batch.map(m => m.id));
    }
    if (history) for (const id of seen) if (id >= offsetId) seen.delete(id);
    await wait(100);
  }
  ctx.log.info("dme:complete", { requested: count, matched, deleted, edited, failed, failedEdits });
  if (failed || failedEdits) await call(() => client.sendMessage("me", {
    message: `DME ${message.chatId}：已删除 ${deleted} 条；删除失败 ${failed} 条；防撤回编辑失败 ${failedEdits} 条。`,
  }));
}

export default function createDme() {
  const active = new Set<string>();
  const store = (ctx: PluginContext) => ctx.storage.json<Config>("config.json", defaults);
  return definePlugin({renderHelp: renderPluginHelp,
    apiVersion: 1, id: "dme", description: help("."),
    settings: ctx => ({
      id: "dme", title: "防撤回删除", category: "管理",
      getSchema: () => [
        { key: "batchSize", label: "批次大小", type: "number", default: 50, min: 5, max: 100 },
        { key: "searchLimit", label: "搜索限制", type: "number", default: 100, min: 10, max: 500 },
        { key: "retryAttempts", label: "重试次数", type: "number", default: 3, min: 0, max: 10 },
      ],
      getValues: () => store(ctx).read(),
      async setValues(patch, signal) {
        const bounds = { batchSize: [5, 100], searchLimit: [10, 500], retryAttempts: [0, 10] };
        for (const [key, value] of Object.entries(patch)) {
          const range = bounds[key as keyof Config];
          if (!range || typeof value !== "number" || !Number.isInteger(value) || value < range[0] || value > range[1]) throw new Error("Invalid DME setting");
        }
        signal.throwIfAborted(); await store(ctx).update(data => { Object.assign(data, patch); return data; });
      },
    }),
    commands: { dme: {helpOnEmpty: true, helpArgs: ["help","h"],  description: "删除自己的消息，支持防撤回模式", ignoreEdited: true,
      async handle({ message, args, prefix }, ctx) {
        const sub = (args[0] || "").toLowerCase();
        if (!sub || sub === "help" || sub === "h") {
          await ctx.telegram.edit(message, help(prefix), { parseMode: "html" }); return;
        }
        const anti = sub === "-f", token = anti ? args[1] : args[0];
        const count = Number(token);
        if (!token || !/^\d+$/.test(token) || !Number.isSafeInteger(count) || count <= 0) {
          await ctx.telegram.edit(message, "参数错误：请指定正整数删除数量"); return;
        }
        if (active.has(message.chatId)) {
          await ctx.telegram.edit(message, "当前会话已有 DME 删除任务正在执行，请等待任务完成"); return;
        }
        active.add(message.chatId);
        try {
          await ctx.tasks.run(`dme:delete:${message.chatId}`, async scoped => {
            const config = await store(ctx).read();
            await ctx.telegram.withClient((client, signal) => execute(ctx, client,
              AbortSignal.any([signal, scoped]), message, count, anti, config));
          });
        } catch (error) {
          if (!ctx.signal.aborted) {
            ctx.log.error("dme:task");
            // The command may already be deleted; report failures to Saved Messages.
            await ctx.telegram.withClient(async (client, signal) => {
              signal.throwIfAborted();
              await client.sendMessage("me", { message: `DME ${message.chatId} 操作失败，请检查权限、网络和 Telegram 限制后重试。` });
            });
          }
        } finally { active.delete(message.chatId); }
      },
    } },
  });
}
