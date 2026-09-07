import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes, TelegramClient} from "teleproto";

const BOT = "@FinelyGirlsBot";
const IMAGE_COMMANDS: Readonly<Record<string, string>> = {
  rand: "rand", pic: "pic", leg: "leg", ass: "ass", chest: "chest",
  coser: "cos", nsfw: "nsfw", naizi: "naizi",
};
type Runtime = {tail: Promise<void>; cursor: number};

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
      return !photo || Boolean(message.photo || message.document || message.media);
    });
    if (found) { runtime.cursor = Math.max(runtime.cursor, Number(found.id)); return found; }
    if (attempt < 19) await delay(700, signal);
  }
}

async function request(runtime: Runtime, context: PluginContext, invocation: any, command: string, photo: boolean): Promise<void> {
  await context.telegram.edit(invocation.message, photo ? "正在获取图片…" : "正在签到…");
  try {
    await context.telegram.withClient((client, signal) => serial(runtime, async () => {
      signal.throwIfAborted();
      const {Api} = await import("teleproto");
      try { await client.invoke(new Api.contacts.Unblock({id: BOT})); } catch {}
      const before = await client.getMessages(BOT, {limit: 1});
      const latest: any = Array.isArray(before) ? before[0] : undefined;
      runtime.cursor = Math.max(runtime.cursor, Number(latest?.id ?? 0));
      await client.sendMessage(BOT, {message: photo ? `/${command}` : "/checkin"});
      const response = await waitFor(runtime, client, signal, photo);
      if (!response) throw new Error("timeout");
      if (!photo) {
        await context.telegram.edit(invocation.message, `✅ <b>签到完成</b>\n\n${escape(response.message || "签到成功")}`, {parseMode: "html"});
        return;
      }
      const raw = invocation.message.raw as ApiTypes.Message | undefined;
      if (!raw?.peerId || !response.media) throw new Error("missing media");
      await client.sendFile(raw.peerId, {file: response.media, spoiler: true, replyTo: invocation.message.replyToId});
      try { await client.markAsRead(BOT); } catch {}
      if (typeof raw.delete === "function") await raw.delete({revoke: true});
    }));
  } catch {
    if (context.signal.aborted) return;
    context.log.error("botmzt_request_failed");
    await context.telegram.edit(invocation.message, photo ? "获取图片失败，请稍后重试" : "签到失败，请稍后重试");
  }
}

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

export default function createBotmzt() {
  const runtime: Runtime = {tail: Promise.resolve(), cursor: 0};
  const commands: Record<string, any> = {
    botmzt: {description: "显示妹子图片插件帮助", async handle(invocation: any, context: PluginContext) {
      await context.telegram.edit(invocation.message,
        `<b>妹子图片插件</b>\n\n<code>${invocation.prefix}rand</code> 随机图片\n` +
        `<code>${invocation.prefix}pic</code> 妹子图片\n<code>${invocation.prefix}leg</code> 腿部图片\n` +
        `<code>${invocation.prefix}ass</code> 臀部图片\n<code>${invocation.prefix}chest</code> 胸部图片\n` +
        `<code>${invocation.prefix}coser</code> Cosplay 图片\n<code>${invocation.prefix}nsfw</code> NSFW 图片\n` +
        `<code>${invocation.prefix}naizi</code> 奶子图片\n<code>${invocation.prefix}qd</code> 签到\n\n图片以剧透模式发送。`,
        {parseMode: "html"});
    }},
    qd: {description: "向图片机器人签到", handle: (invocation: any, context: PluginContext) => request(runtime, context, invocation, "checkin", false)},
  };
  for (const [name, command] of Object.entries(IMAGE_COMMANDS)) {
    commands[name] = {description: "从图片机器人获取剧透图片", handle: (invocation: any, context: PluginContext) => request(runtime, context, invocation, command, true)};
  }
  return definePlugin({apiVersion: 1, id: "botmzt", description: `从 ${BOT} 获取剧透图片`, commands,
    cleanup() { runtime.cursor = 0; runtime.tail = Promise.resolve(); }});
}
