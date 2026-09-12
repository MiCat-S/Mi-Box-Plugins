import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes, TelegramClient} from "teleproto";

const BOT = "@FinelyGirlsBot";
const IMAGE_COMMANDS: Readonly<Record<string, string>> = {
  rand: "rand", pic: "pic", leg: "leg", ass: "ass", chest: "chest",
  coser: "cos", nsfw: "nsfw", naizi: "naizi",
};
type Runtime = {tail: Promise<void>; cursor: number};
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

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
async function request(runtime: Runtime, context: PluginContext, invocation: CommandInvocation, command: string, photo: boolean): Promise<void> {
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
      if (typeof raw.delete === "function") { try { await raw.delete({revoke: true}); }
        catch { if (!context.signal.aborted) context.log.info("botmzt_receipt_cleanup_failed"); } }
    }));
  } catch {
    if (context.signal.aborted) return;
    context.log.error("botmzt_request_failed");
    await context.telegram.edit(invocation.message, photo ? "获取图片失败，请稍后重试" : "签到失败，请稍后重试");
  }
}

export default function createBotmzt() {
  const runtime: Runtime = {tail: Promise.resolve(), cursor: 0};
  const descriptions: Record<string, string> = {rand: "随机图片", pic: "妹子图片", leg: "腿部图片", ass: "臀部图片", chest: "胸部图片", coser: "Cosplay图片", nsfw: "NSFW图片", naizi: "奶子图片"};
  const commands: Record<string, CommandDefinition> = {};
  const renderHelp = (prefix: string): string => [
    "<b>🎨 妹子图片插件</b>",
    ...Object.entries(commands).map(([name, command]) => renderCommandHelp(name, command, {prefix})),
  ].join("\n\n");
  commands.botmzt = {
    description: "显示插件设置和帮助",
    args: "",
    examples: [{args: "", description: "显示图片命令与说明"}],
    help: [{heading: "说明：", body: "所有图片都会以剧透模式发送，需要点击查看。"}],
    async handle(invocation, context) {
      await context.telegram.edit(invocation.message, renderHelp(invocation.prefix), {parseMode: "html"});
    },
  };
  commands.qd = {
    description: "签到命令",
    args: "",
    examples: [{args: "", description: "向 @FinelyGirlsBot 签到"}],
    handle: (invocation, context) => request(runtime, context, invocation, "checkin", false),
  };
  for (const name of Object.keys(IMAGE_COMMANDS)) {
    commands[name] = {
      description: descriptions[name] ?? "图片",
      args: "",
      examples: [{args: "", description: `获取${descriptions[name] ?? name}`}],
      handle: (invocation, context) => request(runtime, context, invocation, IMAGE_COMMANDS[name]!, true),
    };
  }
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "botmzt", description: `从 ${BOT} 获取剧透图片`, renderHelp, commands,
    cleanup() { runtime.cursor = 0; runtime.tail = Promise.resolve(); }});
}
