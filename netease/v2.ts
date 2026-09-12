import {setTimeout as delay} from "node:timers/promises";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const BOT = "Music163bot";
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function botCommand(input: string): string {
  if (/^\d+$/.test(input)) return `/music ${input}`;
  const id = /(?:song\?id=|\/song\/)(\d+)/.exec(input)?.[1];
  return id ? `/music ${id}` : `/search ${input}`;
}


async function recent(client: any): Promise<ApiTypes.Message[]> {
  return await client.getMessages(BOT, {limit: 6}) as ApiTypes.Message[];
}

class Runtime {
  readonly cursors = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly controller = new AbortController();
  get signal(): AbortSignal { return this.controller.signal; }
  serial<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(BOT) ?? Promise.resolve();
    let started = false;
    const queued = previous.catch(() => undefined).then(() => { started = true; signal.throwIfAborted(); return operation(); });
    const tail = queued.then(() => undefined, () => undefined);
    this.tails.set(BOT, tail);
    void tail.finally(() => { if (this.tails.get(BOT) === tail) this.tails.delete(BOT); });
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => { if (settled) return; settled = true; signal.removeEventListener("abort", abort); callback(); };
      const abort = () => { if (!started) finish(() => reject(signal.reason)); };
      signal.addEventListener("abort", abort, {once: true});
      if (signal.aborted) abort();
      queued.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
  }
  dispose(): void { if (!this.controller.signal.aborted) this.controller.abort(new DOMException("Plugin disposed", "AbortError")); this.cursors.clear(); this.tails.clear(); }
}

function messageId(message: any): number { return Number.isSafeInteger(message?.id) && message.id > 0 ? message.id : 0; }
async function boundary(runtime: Runtime, client: any, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const current = Math.max(runtime.cursors.get(BOT) ?? 0, ...(await recent(client)).map(messageId));
  runtime.cursors.set(BOT, current); return current;
}
function advance(runtime: Runtime, value: any): number {
  const current = Math.max(runtime.cursors.get(BOT) ?? 0, messageId(value)); runtime.cursors.set(BOT, current); return current;
}
async function waitFor(runtime: Runtime, client: any, signal: AbortSignal, after: number,
  accept: (message: ApiTypes.Message) => boolean): Promise<ApiTypes.Message | undefined> {
  for (let attempt = 0; attempt < 20; attempt++) {
    signal.throwIfAborted();
    const found = (await recent(client)).filter(message => !message.out && messageId(message) > after && accept(message))
      .sort((left, right) => messageId(left) - messageId(right))[0];
    if (found) { advance(runtime, found); return found; }
    if (attempt < 19) await delay(700, undefined, {signal});
  }
}

export default function createNetease() {
  const runtime = new Runtime();
  const command: CommandDefinition = {
    args: "关键词|歌曲链接|歌曲ID", arguments: [{name: "输入", description: "按关键词搜索并返回音频，或解析网易云歌曲链接与数字 ID"}],
    examples: [{args: "晴天"}, {args: "https://music.163.com/#/song?id=123456"}, {args: "123456"}],
    help: [{heading: "依赖：", body: "通过 @Music163bot 搜索和发送音乐，插件会与该机器人交互。"}],
    helpArgs: ["help","h"], description: "搜索和发送网易云音乐", async handle(invocation, context) {
      const keyword = invocation.args.join(" ").trim();
      if (!keyword || ["help", "h"].includes(keyword.toLowerCase())) {
        await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
        return;
      }
      try {
        await context.telegram.edit(invocation.message, "正在获取音乐…");
        await context.telegram.withClient(async (client, clientSignal) => {
          const signal = AbortSignal.any([clientSignal, runtime.signal]);
          return runtime.serial(signal, async () => {
          const {Api} = await import("teleproto");
          const raw = invocation.message.raw as ApiTypes.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          try { await client.invoke(new Api.contacts.Unblock({id: BOT})); } catch {}
          try { await client.invoke(new Api.messages.StartBot({bot: BOT, peer: BOT, startParam: ""})); } catch {}
          let after = await boundary(runtime, client, signal);
          const sent = await client.sendMessage(BOT, {message: botCommand(keyword)});
          after = Math.max(after, advance(runtime, sent));
          const response = await waitFor(runtime, client, signal, after, message => Boolean(message.media) || Number(message.buttonCount ?? 0) > 0);
          let media = response?.media ? response : undefined;
          const buttons = !media ? response : undefined;
          if (!media && buttons) {
            let mediaAfter = await boundary(runtime, client, signal);
            const clicked = await buttons.click({});
            mediaAfter = Math.max(mediaAfter, advance(runtime, clicked));
            media = await waitFor(runtime, client, signal, mediaAfter, message => Boolean(message.media));
          }
          if (!media?.media) {
            await context.telegram.edit(invocation.message, "未获取到音乐文件，请稍后重试");
            return;
          }
          const caption = (media.message ?? "").replace(/\s*via\s+@Music163bot\s*$/i, "").trim() || `🎵 ${keyword}`;
          await client.sendFile(raw.peerId, {file: media.media, caption, replyTo: invocation.message.replyToId});
          if (typeof raw.delete === "function") {
            try { await raw.delete({revoke: true}); }
            catch { context.log.error("netease_command_cleanup_failed"); }
          }
          });
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("netease_failed");
        await context.telegram.edit(invocation.message, "网易云音乐获取失败，请稍后重试");
      }
    }};
  const help = (prefix: string) => renderCommandHelp("netease", command, {prefix, title: "🎵 网易云音乐"});
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "netease", description: "通过 Music163bot 搜索和发送网易云音乐",
    commands: {netease: command}, cleanup() { runtime.dispose(); },
  });
}
