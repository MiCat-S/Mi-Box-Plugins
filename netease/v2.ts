import { renderHelp as renderPluginHelp } from "./v2/help";
import { setTimeout as delay } from "node:timers/promises";
import { definePlugin } from "telebox/sdk";
import type { Api as ApiTypes } from "teleproto";

const BOT = "Music163bot";
const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>\"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );
function botCommand(input: string): string {
  if (/^\d+$/.test(input)) return `/music ${input}`;
  let netease = false;
  try {
    const hostname = new URL(input).hostname.toLowerCase();
    netease = hostname === "music.163.com" || hostname.endsWith(".music.163.com");
  } catch {
    /* ordinary search text */
  }
  const id = netease ? /(?:song\?id=|\/song\/)(\d+)/.exec(input)?.[1] : undefined;
  return id ? `/music ${id}` : `/search ${input}`;
}

async function recent(client: any, signal: AbortSignal): Promise<ApiTypes.Message[]> {
  const messages = (await client.getMessages(BOT, { limit: 6 })) as ApiTypes.Message[];
  signal.throwIfAborted();
  return messages;
}

const messageId = (message: any): number => (Number.isSafeInteger(message?.id) && message.id > 0 ? message.id : 0);

class BotSession {
  private tail = Promise.resolve();
  private cursor = 0;
  private readonly controller = new AbortController();
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  boundary(messages: readonly any[]): number {
    for (const message of messages) this.cursor = Math.max(this.cursor, messageId(message));
    return this.cursor;
  }
  serial<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let started = false;
    const queued = previous
      .catch(() => undefined)
      .then(() => {
        started = true;
        signal.throwIfAborted();
        return operation();
      });
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        callback();
      };
      const abort = () => {
        if (!started) finish(() => reject(signal.reason));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      queued.then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error)),
      );
    });
  }
  dispose(): void {
    if (!this.controller.signal.aborted) this.controller.abort(new DOMException("Plugin disposed", "AbortError"));
    this.tail = Promise.resolve();
    this.cursor = 0;
  }
}

export default function createNetease() {
  const session = new BotSession();
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "netease",
    description: "通过 Music163bot 搜索和发送网易云音乐",
    commands: {
      netease: {
        helpArgs: ["help", "h"],
        helpOnEmpty: true,
        description: "搜索和发送网易云音乐",
        async handle(invocation, context) {
          const keyword = invocation.args.join(" ").trim();
          if (!keyword || ["help", "h"].includes(keyword.toLowerCase())) {
            await context.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), { parseMode: "html" });
            return;
          }
          try {
            await context.telegram.edit(invocation.message, "正在获取音乐…");
            await context.telegram.withClient(async (client, clientSignal) =>
              session.serial(AbortSignal.any([clientSignal, session.signal]), async () => {
                const signal = AbortSignal.any([clientSignal, session.signal]);
                const { Api } = await import("teleproto");
                signal.throwIfAborted();
                const raw = invocation.message.raw as ApiTypes.Message | undefined;
                if (!raw?.peerId) throw new Error("Missing peer");
                const cleanup = async (): Promise<void> => {
                  if (typeof raw.delete !== "function") return;
                  try {
                    await raw.delete({ revoke: true });
                  } catch {
                    signal.throwIfAborted();
                    context.log.error("netease_cleanup_failed", { kind: "internal" });
                  }
                };
                try {
                  await client.invoke(new Api.contacts.Unblock({ id: BOT }));
                  signal.throwIfAborted();
                } catch {
                  signal.throwIfAborted();
                }
                try {
                  const peer = await client.getInputEntity(BOT);
                  signal.throwIfAborted();
                  await client.invoke(
                    new Api.account.UpdateNotifySettings({
                      peer,
                      settings: new Api.InputPeerNotifySettings({ silent: true, muteUntil: 2147483647 }),
                    }),
                  );
                  signal.throwIfAborted();
                } catch {
                  signal.throwIfAborted();
                }
                try {
                  await client.invoke(new Api.messages.StartBot({ bot: BOT, peer: BOT, startParam: "" }));
                  signal.throwIfAborted();
                } catch {
                  signal.throwIfAborted();
                  try {
                    await client.sendMessage(BOT, { message: "/start" });
                    signal.throwIfAborted();
                  } catch {
                    signal.throwIfAborted();
                  }
                }
                const before = await recent(client, signal);
                let boundary = session.boundary(before);
                const command = botCommand(keyword);
                try {
                  const sent = await client.sendMessage(BOT, { message: command });
                  signal.throwIfAborted();
                  boundary = Math.max(boundary, session.boundary([sent]));
                } catch {
                  signal.throwIfAborted();
                  try {
                    const sent = await client.sendMessage(BOT, {
                      message: command.replace(/^\/(?:search|music)\s+/, ""),
                    });
                    signal.throwIfAborted();
                    boundary = Math.max(boundary, session.boundary([sent]));
                  } catch {
                    signal.throwIfAborted();
                  }
                }
                let buttons: ApiTypes.Message | undefined;
                let media: ApiTypes.Message | undefined;
                let lastMsgId: number | undefined;
                const markRead = async (): Promise<void> => {
                  if (!lastMsgId) return;
                  try {
                    const peer = await client.getInputEntity(BOT);
                    signal.throwIfAborted();
                    await client.invoke(new Api.messages.ReadHistory({ peer, maxId: lastMsgId }));
                    signal.throwIfAborted();
                  } catch {
                    signal.throwIfAborted();
                  }
                };
                for (let attempt = 0; attempt < 20 && !media && !buttons; attempt++) {
                  await delay(700, undefined, { signal });
                  for (const message of (await recent(client, signal)).slice().reverse()) {
                    if (message.out || messageId(message) <= boundary) continue;
                    lastMsgId ??= message.id;
                    if (message.media) media = message;
                    else if ((message.buttonCount ?? 0) > 0) buttons = message;
                  }
                }
                if (media) boundary = session.boundary([media]);
                if (buttons) boundary = session.boundary([buttons]);
                if (!media && buttons) {
                  boundary = session.boundary(await recent(client, signal));
                  try {
                    await buttons.click({});
                    signal.throwIfAborted();
                  } catch {
                    signal.throwIfAborted();
                    await context.telegram.edit(invocation.message, "点击歌曲按钮失败，请稍后重试");
                    await markRead();
                    await cleanup();
                    return;
                  }
                  for (let attempt = 0; attempt < 20 && !media; attempt++) {
                    await delay(700, undefined, { signal });
                    media = (await recent(client, signal))
                      .slice()
                      .reverse()
                      .find(message => !message.out && messageId(message) > boundary && Boolean(message.media));
                    if (media) lastMsgId = media.id;
                  }
                }
                if (media) session.boundary([media]);
                await markRead();
                if (!media?.media) {
                  await context.telegram.edit(invocation.message, "未获取到音乐文件，请稍后重试");
                  await cleanup();
                  return;
                }
                const caption =
                  (media.message ?? "").replace(/\s*via\s+@Music163bot\s*$/i, "").trim() || `🎵 ${keyword}`;
                await client.sendFile(raw.peerId, {
                  file: media.media,
                  caption,
                  replyTo: invocation.message.replyToId,
                });
                signal.throwIfAborted();
                await cleanup();
              }),
            );
          } catch {
            context.signal.throwIfAborted();
            context.log.error("netease_failed");
            await context.telegram.edit(invocation.message, "网易云音乐获取失败，请稍后重试");
          }
        },
      },
    },
    cleanup() {
      session.dispose();
    },
  });
}
