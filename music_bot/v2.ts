import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes, TelegramClient} from "teleproto";

const BOTS = {default: "@music_v1bot", vk: "@vkmusic_bot", ym: "@ttaudiobot"} as const;
const ACTIONS = new Set(["search", "kugou", "kuwo", "qq", "netease", "vk", "ym"]);

class MusicBotState {
  readonly ready = new Set<string>();
  readonly cursors = new Map<string, number>();
  private readonly controller = new AbortController();
  private readonly tails = new Map<string, Promise<void>>();

  get signal(): AbortSignal { return this.controller.signal; }

  serial<T>(bot: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(bot) ?? Promise.resolve();
    let started = false;
    const queued = previous.catch(() => undefined).then(() => {
      started = true;
      signal.throwIfAborted();
      return operation();
    });
    const tail = queued.then(() => undefined, () => undefined);
    this.tails.set(bot, tail);
    void tail.finally(() => {
      if (this.tails.get(bot) === tail) this.tails.delete(bot);
    });

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        callback();
      };
      // A cancelled waiter settles for its caller now, but its queue node stays
      // behind the predecessor so later work cannot overtake in-flight work.
      const abort = (): void => {
        if (!started) finish(() => reject(signal.reason));
      };
      signal.addEventListener("abort", abort, {once: true});
      if (signal.aborted) abort();
      queued.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
  }

  boundary(bot: string, observed = 0): number {
    const boundary = Math.max(this.cursors.get(bot) ?? 0, observed);
    if (boundary > 0) this.cursors.set(bot, boundary);
    return boundary;
  }

  dispose(): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(new DOMException("Plugin disposed", "AbortError"));
    }
    this.ready.clear();
    this.cursors.clear();
    this.tails.clear();
  }
}

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

function validMessageId(message: any): number | undefined {
  const id = message?.id;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

async function captureBoundary(state: MusicBotState, client: TelegramClient, bot: string,
  signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const history = await messages(client, bot, 8);
  signal.throwIfAborted();
  let maximum = 0;
  for (const message of history) maximum = Math.max(maximum, validMessageId(message) ?? 0);
  return state.boundary(bot, maximum);
}

function raiseBoundary(state: MusicBotState, bot: string, boundary: number, message: any): number {
  return state.boundary(bot, Math.max(boundary, validMessageId(message) ?? 0));
}

async function waitFor(state: MusicBotState, client: TelegramClient, bot: string, signal: AbortSignal,
  boundary: number, attempts: number, accept: (message: any) => boolean): Promise<any | undefined> {
  for (let index = 0; index < attempts; index++) {
    signal.throwIfAborted();
    const values = await messages(client, bot, 8);
    signal.throwIfAborted();
    const found = values.filter(message => {
      const id = validMessageId(message);
      return id !== undefined && id > boundary && message?.out === false && accept(message);
    }).sort((left, right) => validMessageId(left)! - validMessageId(right)!)[0];
    if (found) {
      state.boundary(bot, validMessageId(found));
      return found;
    }
    if (index + 1 < attempts) await sleep(700, signal);
  }
}

async function initialize(state: MusicBotState, client: TelegramClient, bot: string, signal: AbortSignal): Promise<void> {
  if (state.ready.has(bot)) return;
  const boundary = await captureBoundary(state, client, bot, signal);
  signal.throwIfAborted();
  const sent = await client.sendMessage(bot, {message: "/start"});
  signal.throwIfAborted();
  raiseBoundary(state, bot, boundary, sent);
  state.ready.add(bot);
}

async function sendOnce(state: MusicBotState, client: TelegramClient, bot: string, request: string,
  signal: AbortSignal): Promise<number> {
  const boundary = await captureBoundary(state, client, bot, signal);
  signal.throwIfAborted();
  const sent = await client.sendMessage(bot, {message: request});
  signal.throwIfAborted();
  return raiseBoundary(state, bot, boundary, sent);
}

async function sendRequest(state: MusicBotState, client: TelegramClient, bot: string, request: string,
  signal: AbortSignal): Promise<number> {
  const boundary = await captureBoundary(state, client, bot, signal);
  try {
    signal.throwIfAborted();
    const sent = await client.sendMessage(bot, {message: request});
    signal.throwIfAborted();
    return raiseBoundary(state, bot, boundary, sent);
  } catch {
    signal.throwIfAborted();
    await initialize(state, client, bot, signal);
    await sleep(500, signal);
    return sendOnce(state, client, bot, request, signal);
  }
}

async function search(state: MusicBotState, context: PluginContext, invocation: any,
  action: string, query: string, bot: string): Promise<void> {
  if (!ACTIONS.has(action) || !query.trim() || query.length > 300) {
    await context.telegram.edit(invocation.message,
      `<b>多音源音乐搜索</b>\n<code>${invocation.prefix}music_bot search 关键词</code>\n` +
      `<code>${invocation.prefix}mbvk 关键词</code> · <code>${invocation.prefix}mbym 关键词</code>\n` +
      `支持 search、kugou、kuwo、qq、netease、vk、ym。`, {parseMode: "html"});
    return;
  }
  await context.telegram.edit(invocation.message, `正在搜索：${query}`);
  let operationSignal: AbortSignal | undefined;
  try {
    await context.telegram.withClient(async (client, clientSignal) => {
      const signal = AbortSignal.any([clientSignal, state.signal]);
      operationSignal = signal;
      return state.serial(bot, signal, async () => {
        signal.throwIfAborted();
        const {Api} = await import("teleproto");
        try { await client.invoke(new Api.contacts.Unblock({id: bot})); } catch {}
        signal.throwIfAborted();
        try {
          const peer = await client.getInputEntity(bot);
          signal.throwIfAborted();
          await client.invoke(new Api.account.UpdateNotifySettings({peer,
            settings: new Api.InputPeerNotifySettings({silent: true, muteUntil: 2_147_483_647})}));
        } catch {}
        signal.throwIfAborted();
        const request = action === "vk" || action === "ym" ? query : `/${action} ${query}`;
        const choicesBoundary = await sendRequest(state, client, bot, request, signal);
        const choices = await waitFor(state, client, bot, signal, choicesBoundary, 15,
          message => Number(message.buttonCount ?? 0) > 0);
        if (!choices) throw new Error("No choices");
        let mediaBoundary = await captureBoundary(state, client, bot, signal);
        let clicked = false;
        for (const value of [{i: 0}, {row: 0, col: 0}, {text: "1"}]) {
          signal.throwIfAborted();
          try {
            const result = await choices.click(value);
            signal.throwIfAborted();
            mediaBoundary = raiseBoundary(state, bot, mediaBoundary, result);
            clicked = true;
            break;
          } catch {
            signal.throwIfAborted();
          }
        }
        if (!clicked) mediaBoundary = await sendOnce(state, client, bot, "1", signal);
        const media = await waitFor(state, client, bot, signal, mediaBoundary, 20, message => Boolean(message.media));
        if (!media?.media) throw new Error("No media");
        const raw = invocation.message.raw as ApiTypes.Message | undefined;
        if (!raw?.peerId) throw new Error("Missing peer");
        signal.throwIfAborted();
        await client.sendFile(raw.peerId, {file: media.media, replyTo: invocation.message.replyToId,
          ...(action === "ym" ? {} : {caption: `🎵 ${query}`})});
        signal.throwIfAborted();
        if (typeof raw.delete === "function") await raw.delete({revoke: true});
      });
    });
  } catch (error) {
    if (context.signal.aborted || state.signal.aborted || operationSignal?.aborted ||
        error instanceof DOMException && error.name === "AbortError") return;
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
  const state = new MusicBotState();
  const commands = Object.fromEntries(Object.entries(BINDINGS).map(([name, binding]) => [name, {
    description: "通过 Telegram 音乐机器人搜索并发送歌曲", async handle(invocation: any, context: PluginContext) {
      const action = binding.nested ? (invocation.args[0]?.toLowerCase() ?? "") : binding.action;
      const query = invocation.args.slice(binding.nested ? 1 : 0).join(" ").trim();
      const bot = action === "vk" ? BOTS.vk : action === "ym" ? BOTS.ym : binding.bot;
      await search(state, context, invocation, action, query, bot);
    },
  }]));
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "music_bot", description: "通过多个 Telegram 音乐机器人搜索歌曲",
    commands, cleanup() { state.dispose(); }});
}
