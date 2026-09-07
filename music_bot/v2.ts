import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes, TelegramClient} from "teleproto";

const BOTS = {default: "@music_v1bot", vk: "@vkmusic_bot", ym: "@ttaudiobot"} as const;
const ACTIONS = new Set(["search", "kugou", "kuwo", "qq", "netease", "vk", "ym"]);
const ready = new Set<string>();

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); }
    signal.addEventListener("abort", abort, {once: true});
  });
}

async function messages(client: TelegramClient, bot: string, limit: number): Promise<any[]> {
  const values = await client.getMessages(bot, {limit});
  return Array.isArray(values) ? values : [];
}

async function waitFor(client: TelegramClient, bot: string, signal: AbortSignal,
  attempts: number, accept: (message: any) => boolean): Promise<any | undefined> {
  for (let index = 0; index < attempts; index++) {
    signal.throwIfAborted();
    const found = (await messages(client, bot, 8)).slice().reverse().find(accept);
    if (found) return found;
    if (index + 1 < attempts) await sleep(700, signal);
  }
}

async function initialize(client: TelegramClient, bot: string): Promise<void> {
  if (ready.has(bot)) return;
  await client.sendMessage(bot, {message: "/start"});
  ready.add(bot);
}

async function search(context: PluginContext, invocation: any, action: string, query: string, bot: string): Promise<void> {
  if (!ACTIONS.has(action) || !query.trim() || query.length > 300) {
    await context.telegram.edit(invocation.message,
      `<b>多音源音乐搜索</b>\n<code>${invocation.prefix}music_bot search 关键词</code>\n` +
      `<code>${invocation.prefix}mbvk 关键词</code> · <code>${invocation.prefix}mbym 关键词</code>\n` +
      `支持 search、kugou、kuwo、qq、netease、vk、ym。`, {parseMode: "html"});
    return;
  }
  await context.telegram.edit(invocation.message, `正在搜索：${query}`);
  try {
    await context.telegram.withClient(async (client, signal) => {
      const {Api} = await import("teleproto");
      try { await client.invoke(new Api.contacts.Unblock({id: bot})); } catch {}
      try {
        const peer = await client.getInputEntity(bot);
        await client.invoke(new Api.account.UpdateNotifySettings({peer: new Api.InputNotifyPeer({peer}),
          settings: new Api.InputPeerNotifySettings({silent: true, muteUntil: 2_147_483_647})}));
      } catch {}
      const started = Math.floor(Date.now() / 1000);
      const request = action === "vk" || action === "ym" ? query : `/${action} ${query}`;
      try { await client.sendMessage(bot, {message: request}); }
      catch { await initialize(client, bot); await sleep(500, signal); await client.sendMessage(bot, {message: request}); }
      const choices = await waitFor(client, bot, signal, 15, message =>
        !message.out && Number(message.date ?? 0) >= started && Number(message.buttonCount ?? 0) > 0);
      if (!choices) throw new Error("No choices");
      let clicked = false;
      for (const value of [{i: 0}, {row: 0, col: 0}, {text: "1"}]) {
        try { await choices.click(value); clicked = true; break; } catch {}
      }
      if (!clicked) await client.sendMessage(bot, {message: "1"});
      const media = await waitFor(client, bot, signal, 20, message =>
        !message.out && Number(message.date ?? 0) >= Number(choices.date ?? started) && Boolean(message.media));
      if (!media?.media) throw new Error("No media");
      const raw = invocation.message.raw as ApiTypes.Message | undefined;
      if (!raw?.peerId) throw new Error("Missing peer");
      await client.sendFile(raw.peerId, {file: media.media, replyTo: invocation.message.replyToId,
        ...(action === "ym" ? {} : {caption: `🎵 ${query}`})});
      if (typeof raw.delete === "function") await raw.delete({revoke: true});
    });
  } catch {
    if (context.signal.aborted) return;
    context.log.error("music_bot_failed");
    await context.telegram.edit(invocation.message, `音乐搜索失败，请先打开 ${bot} 并点击 Start 后重试`);
  }
}

type Binding = {action: string; bot: string; nested?: boolean};
const BINDINGS: Readonly<Record<string, Binding>> = {
  music_bot: {action: "", bot: BOTS.default, nested: true}, mbs: {action: "search", bot: BOTS.default},
  mbkw: {action: "kuwo", bot: BOTS.default}, mbkg: {action: "kugou", bot: BOTS.default},
  mbqq: {action: "qq", bot: BOTS.default}, mbne: {action: "netease", bot: BOTS.default},
  mbvk: {action: "vk", bot: BOTS.vk}, mbym: {action: "ym", bot: BOTS.ym},
};

export default function createMusicBot() {
  const commands = Object.fromEntries(Object.entries(BINDINGS).map(([name, binding]) => [name, {
    description: "通过 Telegram 音乐机器人搜索并发送歌曲", async handle(invocation: any, context: PluginContext) {
      const action = binding.nested ? (invocation.args[0]?.toLowerCase() ?? "") : binding.action;
      const query = invocation.args.slice(binding.nested ? 1 : 0).join(" ").trim();
      const bot = action === "vk" ? BOTS.vk : action === "ym" ? BOTS.ym : binding.bot;
      await search(context, invocation, action, query, bot);
    },
  }]));
  return definePlugin({apiVersion: 1, id: "music_bot", description: "通过多个 Telegram 音乐机器人搜索歌曲",
    commands, cleanup() { ready.clear(); }});
}
