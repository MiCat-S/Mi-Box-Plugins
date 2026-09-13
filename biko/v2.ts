import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const MAX_MESSAGES = 200;
const MAX_SCAN = 3000;
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

type Selector = {entity?: ApiTypes.User; id?: string; username?: string; display: string};
type RecordItem = {day: string; time: string; text: string; link?: string};

function normalizedId(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    const nested = item.userId ?? item.channelId ?? item.chatId;
    return nested === undefined ? String(value) : normalizedId(nested);
  }
  return String(value);
}

function input(value: string, returnBigInt: (value: string) => unknown): unknown {
  return /^-?\d+$/.test(value) ? returnBigInt(value) : value;
}

function display(entity: any, fallback: string): string {
  return [entity?.title, entity?.firstName, entity?.lastName, entity?.username && `@${entity.username}`, entity?.id]
    .filter(value => value !== undefined && value !== null && String(value).trim()).map(String).join(" ") || fallback;
}

function mediaText(message: any): string {
  const text = String(message?.message ?? message?.text ?? "").trim();
  if (message?.className === "MessageService") {
    const action = String(message?.action?.className ?? "").replace(/^MessageAction/, "").trim();
    return text || (action ? `[服务消息:${action}]` : "[服务消息]");
  }
  const attributes = Array.isArray(message?.document?.attributes) ? message.document.attributes : [];
  const documentMarker = attributes.some((attribute: any) => attribute?.className === "DocumentAttributeSticker") ? "[贴纸]" :
    attributes.some((attribute: any) => attribute?.className === "DocumentAttributeAudio" && attribute?.voice) ? "[语音]" :
    attributes.some((attribute: any) => attribute?.className === "DocumentAttributeAudio") ? "[音频]" :
    attributes.some((attribute: any) => attribute?.className === "DocumentAttributeVideo") ? "[视频]" :
    attributes.some((attribute: any) => attribute?.className === "DocumentAttributeAnimated") ? "[动图]" : "[文档]";
  const marker = message?.photo ? "[图片]" : message?.video ? "[视频]" : message?.voice ? "[语音]" :
    message?.audio ? "[音频]" : message?.sticker ? "[贴纸]" : message?.document ? documentMarker :
    message?.poll ? "[投票]" : message?.contact ? "[联系人]" : message?.location || message?.venue ? "[位置]" :
    message?.media ? "[媒体消息]" : "";
  const value = [marker, text].filter(Boolean).join(" ").replace(/\s*\r?\n\s*/g, " / ").replace(/\s+/g, " ").trim() || "[空消息]";
  return value.length > 240 ? `${value.slice(0, 240)}…` : value;
}

function dateParts(value: unknown): {day: string; time: string} {
  const date = value instanceof Date ? value :
    typeof value === "number" || typeof value === "bigint" ? new Date(Number(value) * 1000) : new Date();
  return {
    day: date.toLocaleDateString("zh-CN", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}),
    time: date.toLocaleTimeString("zh-CN", {timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false}),
  };
}

function link(chat: any, messageId: number): string | undefined {
  if (chat?.username) return `https://t.me/${chat.username}/${messageId}`;
  if (chat?.className === "Channel" && chat.id) return `https://t.me/c/${chat.id}/${messageId}`;
  return undefined;
}

async function matches(message: any, selector: Selector, signal: AbortSignal): Promise<boolean> {
  if (selector.entity) return true;
  if (selector.id) return normalizedId(message?.senderId ?? message?.fromId?.userId) === selector.id;
  const direct = String(message?.sender?.username ?? "").replace(/^@/, "").toLowerCase();
  if (direct === selector.username) return true;
  if (typeof message?.getSender !== "function") return false;
  try {
    const sender = await message.getSender();
    signal.throwIfAborted();
    return String(sender?.username ?? "").replace(/^@/, "").toLowerCase() === selector.username;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

function pages(header: string, records: readonly RecordItem[]): string[] {
  const lines: string[] = [];
  let day = "";
  for (const record of records) {
    if (record.day !== day) { day = record.day; lines.push(`\n📅 <b>${escape(day)}</b>`); }
    const body = record.link ? `<a href="${escape(record.link)}">${escape(record.text)}</a>` : escape(record.text);
    lines.push(`• <code>${escape(record.time)}</code> ${body}`);
  }
  const result: string[] = [];
  let current = header;
  for (const line of lines) {
    if (`${current}\n${line}`.length > 3500) result.push(current), current = `<b>Biko 消息整理（续）</b>\n${line}`;
    else current += `\n${line}`;
  }
  result.push(current);
  return result;
}

export default function createBiko() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "biko", description: "整理指定用户在来源对话中的消息并发送到目标对话",
    commands: {biko: {helpArgs: ["help"], helpOnEmpty: true, description: "跨对话整理指定用户的近期消息", async handle(invocation, context) {
      if (invocation.args[0]?.toLowerCase() === "help" || invocation.args.length !== 4) {
        await context.telegram.edit(invocation.message,
          `<b>Biko 消息整理</b>\n<code>${escape(invocation.prefix)}biko 来源对话 来源用户 最大消息数 目标对话</code>\n最大消息数 ${MAX_MESSAGES}。`,
          {parseMode: "html", linkPreview: false});
        return;
      }
      const [sourceRaw, userRaw, countRaw, targetRaw] = invocation.args;
      if (!/^\d+$/.test(countRaw!) || Number(countRaw) < 1) {
        await context.telegram.edit(invocation.message, "最大消息数必须是大于 0 的整数");
        return;
      }
      const count = Math.min(Number(countRaw), MAX_MESSAGES);
      try {
        await context.telegram.edit(invocation.message, "正在解析对话和用户…");
        await context.telegram.withClient(async (client, signal) => {
          const {Api} = await import("teleproto");
          const {returnBigInt} = await import("teleproto/Helpers.js");
          const [source, target] = await Promise.all([
            client.getEntity(input(sourceRaw!, returnBigInt) as never),
            client.getEntity(input(targetRaw!, returnBigInt) as never),
          ]);
          signal.throwIfAborted();
          const resolveSelector = async (): Promise<Selector> => {
            const entity = await client.getEntity(input(userRaw!, returnBigInt) as never);
            signal.throwIfAborted();
            if (!(entity instanceof Api.User)) throw new Error("Not user");
            return {entity, display: display(entity, userRaw!)};
          };
          let selector: Selector;
          try { selector = await resolveSelector(); }
          catch {
            signal.throwIfAborted();
            selector = /^-?\d+$/.test(userRaw!)
              ? {id: userRaw!, display: userRaw!}
              : {username: userRaw!.replace(/^@/, "").toLowerCase(), display: `@${userRaw!.replace(/^@/, "").toLowerCase()}`};
          }
          const manual = !selector.entity;
          await context.telegram.edit(invocation.message, [
            "🔄 正在整理消息...",
            `<b>来源对话:</b> ${escape(display(source, sourceRaw!))}`,
            `<b>来源用户:</b> ${escape(selector.display)}`,
            `<b>目标对话:</b> ${escape(display(target, targetRaw!))}`,
            `<b>消息数:</b> ${count}`,
            ...(manual ? ["⚠️ 源用户实体解析失败，已切换为手动过滤模式"] : []),
          ].join("\n"), {parseMode: "html", linkPreview: false});
          signal.throwIfAborted();
          const collect = async (active: Selector, limit: number): Promise<RecordItem[]> => {
            const found: RecordItem[] = [];
            for await (const value of client.iterMessages(source, {limit, ...(active.entity ? {fromUser: active.entity} : {})})) {
              signal.throwIfAborted();
              const message = value as ApiTypes.Message;
              const matched = await matches(message, active, signal);
              signal.throwIfAborted();
              if (!matched) continue;
              const parts = dateParts(message.date);
              found.push({...parts, text: mediaText(message), link: link(source, message.id)});
              if (found.length === count) break;
            }
            return found.reverse();
          };
          let records = await collect(selector, selector.entity ? count : Math.min(Math.max(count * 20, count + 50), MAX_SCAN));
          signal.throwIfAborted();
          if (manual && records.length < count) {
            try {
              const retried = await resolveSelector();
              selector = retried;
              records = await collect(retried, count);
            } catch {
              signal.throwIfAborted();
              records = await collect(selector, MAX_SCAN);
            }
          }
          signal.throwIfAborted();
          if (!records.length) {
            await context.telegram.edit(invocation.message,
              `❌ 未找到匹配消息\n\n<b>来源对话:</b> ${escape(display(source, sourceRaw!))}\n<b>来源用户:</b> ${escape(selector.display)}`,
              {parseMode: "html"});
            return;
          }
          const header = `<b>Biko 消息整理</b>\n来源：${escape(display(source, sourceRaw!))}\n用户：${escape(selector.display)}\n目标：${escape(display(target, targetRaw!))}\n消息数：${records.length}${manual ? "\n<b>过滤模式:</b> 手动过滤" : ""}`;
          const chunks = pages(header, records);
          for (const chunk of chunks) {
            signal.throwIfAborted();
            await client.sendMessage(target, {message: chunk, parseMode: "html", linkPreview: false});
            signal.throwIfAborted();
          }
          const summary = [
            `<b>Biko 已发送</b>\n消息 ${records.length} 条 · 分片 ${chunks.length}`,
            "✅ 已发送整理结果",
            `<b>来源对话:</b> ${escape(display(source, sourceRaw!))}`,
            `<b>来源用户:</b> ${escape(selector.display)}`,
            `<b>目标对话:</b> ${escape(display(target, targetRaw!))}`,
            `<b>发送条数:</b> ${records.length}`,
            `<b>发送分片:</b> ${chunks.length}`,
            ...(Number(countRaw) > count ? [`<b>说明:</b> 请求数量已限制为 ${count}`] : []),
            ...(manual ? ["<b>说明:</b> 本次使用手动过滤模式完成匹配"] : []),
          ];
          await context.telegram.edit(invocation.message, summary.join("\n"), {parseMode: "html", linkPreview: false});
        });
      } catch (error) {
        context.signal.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") throw error;
        context.log.error("biko_failed");
        await context.telegram.edit(invocation.message, "Biko 执行失败，请检查对话、用户和访问权限");
      }
    }}},
  });
}
