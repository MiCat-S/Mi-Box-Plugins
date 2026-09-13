import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes, TelegramClient} from "teleproto";
import {returnBigInt} from "teleproto/Helpers";

const BOT = "@FinelyGirlsBot";
const IMAGE_COMMANDS: Readonly<Record<string, string>> = {
  rand: "rand", pic: "pic", leg: "leg", ass: "ass", chest: "chest",
  coser: "cos", nsfw: "nsfw", naizi: "naizi",
};
type Runtime = {tail: Promise<void>; cursor: number};
const ERROR_KEYWORDS = ["没有找到", "错误", "error", "失败", "不存在", "无法", "无效"];

function serial<T>(runtime: Runtime, operation: () => Promise<T>): Promise<T> {
  const previous = runtime.tail;
  let release!: () => void;
  runtime.tail = new Promise<void>(resolve => { release = resolve; });
  return previous.catch(() => undefined).then(operation).finally(release);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); }
    signal.addEventListener("abort", abort, {once: true});
  });
}

async function waitFor(runtime: Runtime, client: TelegramClient, signal: AbortSignal, photo: boolean): Promise<any | undefined> {
  for (let attempt = 0; attempt < 20; attempt++) {
    signal.throwIfAborted();
    const values = await client.getMessages(BOT, {limit: 8});
    const messages = Array.isArray(values) ? values : [];
    const found = messages.slice().reverse().find((message: any) => {
      const id = Number(message?.id ?? 0);
      if (message?.out || !Number.isSafeInteger(id) || id <= runtime.cursor) return false;
      if (!photo || message.photo || message.document || message.media) return true;
      const text = String(message.message ?? "").toLowerCase();
      return ERROR_KEYWORDS.some(keyword => text.includes(keyword));
    });
    if (found) { runtime.cursor = Math.max(runtime.cursor, Number(found.id)); return found; }
    if (attempt < 19) await delay(700, signal);
  }
}

async function request(runtime: Runtime, context: PluginContext, invocation: any, command: string, photo: boolean): Promise<void> {
  await context.telegram.edit(invocation.message, photo ? "🔄 正在获取图片..." : "📅 正在执行签到...", {parseMode: "html"});
  try {
    await context.telegram.withClient((client, signal) => serial(runtime, async () => {
      signal.throwIfAborted();
      const {Api} = await import("teleproto");
      signal.throwIfAborted();
      try { await client.invoke(new Api.contacts.Unblock({id: BOT})); } catch {}
      signal.throwIfAborted();
      const before = await client.getMessages(BOT, {limit: 1});
      signal.throwIfAborted();
      const latest: any = Array.isArray(before) ? before[0] : undefined;
      runtime.cursor = Math.max(runtime.cursor, Number(latest?.id ?? 0));
      if (!Array.isArray(before) || before.length === 0) {
        await client.sendMessage(BOT, {message: "/start"});
        await delay(1000, signal);
        const started = await client.getMessages(BOT, {limit: 1});
        signal.throwIfAborted();
        const startReply: any = Array.isArray(started) ? started[0] : undefined;
        runtime.cursor = Math.max(runtime.cursor, Number(startReply?.id ?? 0));
      }
      signal.throwIfAborted();
      await client.sendMessage(BOT, {message: photo ? `/${command}` : "/checkin"});
      const response = await waitFor(runtime, client, signal, photo);
      signal.throwIfAborted();
      if (!response) throw new Error("timeout");
      if (!photo) {
        await context.telegram.edit(invocation.message, `✅ <b>签到完成</b>\n\n${escape(response.message || "签到成功")}`, {parseMode: "html"});
        return;
      }
      if (!response.media) {
        const message = String(response.message ?? "");
        const knownError = ERROR_KEYWORDS.some(keyword => message.toLowerCase().includes(keyword));
        await context.telegram.edit(invocation.message, knownError
          ? `❌ <b>机器人返回错误:</b> ${escape(message || "未知错误")}`
          : "❌ 机器人没有返回图片，请稍后重试", {parseMode: "html"});
        return;
      }
      const raw = invocation.message.raw as ApiTypes.Message | undefined;
      if (!raw?.peerId) throw new Error("missing media");
      await client.sendFile(raw.peerId, {file: response.media, spoiler: true, replyTo: invocation.message.replyToId});
      signal.throwIfAborted();
      try { await client.markAsRead(BOT); } catch {}
      signal.throwIfAborted();
      if (typeof raw.delete === "function") {
        try { await raw.delete({revoke: true}); }
        catch { context.log.error("botmzt_command_delete_failed"); }
      }
    }));
  } catch (error) {
    if (context.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    context.log.error("botmzt_request_failed");
    const flood = message.match(/FLOOD_WAIT[^0-9]*(\d+)/i);
    if (flood) {
      await context.telegram.edit(invocation.message,
        `⏳ <b>请求过于频繁</b>\n\n需要等待 ${flood[1]} 秒后重试`, {parseMode: "html"});
    } else if (message.includes("USER_BLOCKED")) {
      await context.telegram.edit(invocation.message,
        `❌ <b>无法访问机器人</b>\n\n请先私聊 ${BOT} 并发送 /start`, {parseMode: "html"});
    } else {
      await context.telegram.edit(invocation.message,
        `❌ <b>${photo ? "获取图片" : "签到"}失败</b>，请稍后重试`, {parseMode: "html"});
    }
  }
}

function deleteSettingsLater(context: PluginContext, chatId: string, messageId: number): void {
  void context.tasks.run("botmzt:delete-settings", async signal => {
    try {
      await delay(30000, signal);
      await context.telegram.withClient(async client => {
        signal.throwIfAborted();
        await client.deleteMessages(returnBigInt(chatId), [messageId], {revoke: true});
      });
    } catch (error) {
      if (!signal.aborted) context.log.error("botmzt_settings_delete_failed");
    }
  });
}

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

export default function createBotmzt() {
  const runtime: Runtime = {tail: Promise.resolve(), cursor: 0};
  const commands: Record<string, any> = {
    botmzt: {description: "显示妹子图片插件帮助", async handle(invocation: any, context: PluginContext) {
      await context.telegram.edit(invocation.message,
        `🎨 <b>妹子图片插件设置</b>\n\n<b>当前配置：</b>\n• 机器人: ${BOT}\n` +
        `• 剧透模式: 已启用\n• 自动删除命令: 已启用\n\n<b>可用命令：</b>\n` +
        `<code>${invocation.prefix}rand</code> 随机图片\n` +
        `<code>${invocation.prefix}pic</code> 妹子图片\n<code>${invocation.prefix}leg</code> 腿部图片\n` +
        `<code>${invocation.prefix}ass</code> 臀部图片\n<code>${invocation.prefix}chest</code> 胸部图片\n` +
        `<code>${invocation.prefix}coser</code> Cosplay 图片\n<code>${invocation.prefix}nsfw</code> NSFW 图片\n` +
        `<code>${invocation.prefix}naizi</code> 奶子图片\n\n<b>使用说明：</b>\n` +
        `所有图片都会以剧透模式发送，点击查看。\n此消息将在30秒后自动删除。`,
        {parseMode: "html"});
      deleteSettingsLater(context, invocation.message.chatId, invocation.message.id);
    }},
    qd: {description: "向图片机器人签到", handle: (invocation: any, context: PluginContext) => request(runtime, context, invocation, "checkin", false)},
  };
  for (const [name, command] of Object.entries(IMAGE_COMMANDS)) {
    commands[name] = {description: "从图片机器人获取剧透图片", handle: (invocation: any, context: PluginContext) => request(runtime, context, invocation, command, true)};
  }
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "botmzt", description: `从 ${BOT} 获取剧透图片`, commands,
    cleanup() { runtime.cursor = 0; runtime.tail = Promise.resolve(); }});
}
