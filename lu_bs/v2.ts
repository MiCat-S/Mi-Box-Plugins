import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";

const TIME_ZONE = "Asia/Shanghai";
const STICKER_SET = "luxiaoxunbs";
const SCHEMA_VERSION = 1;
const SEND_CONCURRENCY = 4;

type State = {
  schemaVersion: number;
  subscriptions: string[];
  lastMessages: Record<string, number>;
  [key: string]: unknown;
};

const defaults = (): State => ({schemaVersion: SCHEMA_VERSION, subscriptions: [], lastMessages: {}});
const store = (context: PluginContext) => context.storage.json<State>("subscriptions.json", defaults());

function normalizeState(source: State): State {
  const subscriptions = Array.isArray(source.subscriptions)
    ? [...new Set(source.subscriptions.map(String).filter(Boolean))]
    : [];
  const lastMessages: Record<string, number> = {};
  if (source.lastMessages && typeof source.lastMessages === "object" && !Array.isArray(source.lastMessages)) {
    for (const [chatId, value] of Object.entries(source.lastMessages)) {
      const id = typeof value === "bigint" ? Number(value) : value;
      if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) lastMessages[String(chatId)] = id;
    }
  }
  return {...source, schemaVersion: SCHEMA_VERSION, subscriptions, lastMessages};
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as {code?: unknown; errorMessage?: unknown; message?: unknown};
  for (const candidate of [value.errorMessage, value.code, value.message]) {
    if (typeof candidate !== "string") continue;
    const match = candidate.toUpperCase().match(/(?:^|\b)(CHAT_WRITE_FORBIDDEN|CHAT_NOT_FOUND)(?:\b|$)/);
    if (match) return match[1];
  }
  return "";
}

async function loadStickerSet(context: PluginContext): Promise<unknown> {
  return context.telegram.withClient(async (client, signal) => {
    signal.throwIfAborted();
    const {Api} = await import("teleproto");
    signal.throwIfAborted();
    return client.invoke(new Api.messages.GetStickerSet({
      stickerset: new Api.InputStickerSetShortName({shortName: STICKER_SET}),
      hash: 0,
    }));
  });
}

function shanghaiHour(now = new Date()): {hour: number; minute: number} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const field = (name: string) => Number(parts.find(part => part.type === name)?.value);
  return {hour: field("hour"), minute: field("minute")};
}

function stickerForHour(set: unknown, now = new Date()): unknown | undefined {
  const documents = (set as {documents?: unknown[]} | undefined)?.documents;
  if (!Array.isArray(documents) || !documents.length) return;
  const clock = shanghaiHour(now);
  let hour = clock.hour - 1;
  if (clock.minute > 30) hour += 1;
  hour = ((hour % 12) + 12) % 12;
  return documents[hour % documents.length];
}

async function permitted(context: PluginContext, message: MessageEnvelope): Promise<boolean> {
  const raw = message.raw as {isPrivate?: boolean; isGroup?: boolean; isChannel?: boolean; peerId?: unknown} | undefined;
  if (raw?.isPrivate === true || (!raw?.isGroup && !raw?.isChannel && !message.chatId.startsWith("-"))) return true;
  try {
    return await context.telegram.withClient(async (client, signal) => {
      signal.throwIfAborted();
      const {Api} = await import("teleproto");
      const entity = await client.getEntity((raw?.peerId ?? message.chatId) as any);
      signal.throwIfAborted();
      return (entity instanceof Api.Chat || entity instanceof Api.Channel) &&
        (!!entity.creator || entity.adminRights !== undefined);
    });
  } catch {
    context.signal.throwIfAborted();
    return false;
  }
}

async function eachConcurrent<T>(values: readonly T[], limit: number, operation: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) await operation(values[cursor++]);
  };
  await Promise.all(Array.from({length: Math.min(limit, values.length)}, worker));
}

export default function createLuBs() {
  let cachedSet: unknown;
  let loadingSet: Promise<unknown> | undefined;
  const chatTails = new Map<string, Promise<void>>();

  const getStickerSet = (context: PluginContext, refresh = false): Promise<unknown> => {
    if (refresh) cachedSet = undefined;
    if (cachedSet !== undefined) return Promise.resolve(cachedSet);
    if (!loadingSet) {
      loadingSet = loadStickerSet(context).then(value => (cachedSet = value)).finally(() => { loadingSet = undefined; });
    }
    return loadingSet;
  };

  const withChatLock = async <T>(chatId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = chatTails.get(chatId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    chatTails.set(chatId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (chatTails.get(chatId) === tail) chatTails.delete(chatId);
    }
  };

  const command = {
    description: "管理鲁小迅整点贴纸报时",
    async handle(invocation: {message: MessageEnvelope; prefix: string; args: readonly string[]}, context: PluginContext) {
      const action = (invocation.args[0] ?? "help").toLowerCase();
      const aliases: Record<string, string> = {"订阅": "sub", "退订": "unsub", "列表": "list", "重载": "reload", "帮助": "help"};
      const normalized = aliases[action] ?? action;
      if (normalized === "help" || !["sub", "unsub", "list", "reload"].includes(normalized)) {
        await context.telegram.edit(invocation.message,
          `<b>鲁小迅整点报时</b>\n\n每小时整点自动发送贴纸，并删除上一条报时消息。\n\n` +
          `<code>${invocation.prefix}lu_bs sub</code> - 订阅\n` +
          `<code>${invocation.prefix}lu_bs unsub</code> - 退订\n` +
          `<code>${invocation.prefix}lu_bs list</code> - 查看状态\n` +
          `<code>${invocation.prefix}lu_bs reload</code> - 重载贴纸包\n\n` +
          `群组订阅需要当前账号具有管理员权限。\n` +
          `请先添加贴纸包: <code>https://t.me/addstickers/${STICKER_SET}</code>`, {parseMode: "html"});
        return;
      }
      if (normalized === "reload") {
        try {
          await getStickerSet(context, true);
          await context.telegram.edit(invocation.message, "✅ 贴纸包重新加载成功", {parseMode: "html"});
        } catch {
          if (!context.signal.aborted) {
            await context.telegram.edit(invocation.message, "❌ 贴纸包加载失败，请检查贴纸包名称是否正确", {parseMode: "html"});
          }
        }
        return;
      }
      if (normalized === "list") {
        const state = normalizeState(await store(context).read());
        const subscribed = state.subscriptions.includes(invocation.message.chatId);
        const hint = subscribed ? "unsub" : "sub";
        await context.telegram.edit(invocation.message,
          `<b>订阅状态</b>\n\n• 当前聊天: <code>${subscribed ? "✅ 已订阅" : "❌ 未订阅"}</code>\n` +
          `• 总订阅数: <code>${state.subscriptions.length}</code>\n\n` +
          `使用 <code>${invocation.prefix}lu_bs ${hint}</code> ${subscribed ? "退订" : "订阅"}`, {parseMode: "html"});
        return;
      }
      if (!await permitted(context, invocation.message)) {
        await context.telegram.edit(invocation.message, "❌ 权限不足，无法操作整点报时", {parseMode: "html"});
        return;
      }
      await withChatLock(invocation.message.chatId, async () => {
        let changed = false;
        await store(context).update(source => {
          const state = normalizeState(source);
          const present = state.subscriptions.includes(invocation.message.chatId);
          const enable = normalized === "sub";
          if (present === enable) return state;
          changed = true;
          state.subscriptions = enable
            ? [...state.subscriptions, invocation.message.chatId]
            : state.subscriptions.filter(id => id !== invocation.message.chatId);
          if (!enable) delete state.lastMessages[invocation.message.chatId];
          return state;
        });
        const text = normalized === "sub"
          ? changed ? "✅ 你已经成功订阅了整点报时" : "❌ 你已经订阅了整点报时"
          : changed ? "✅ 你已经成功退订了整点报时" : "❌ 你还没有订阅整点报时";
        await context.telegram.edit(invocation.message, text, {parseMode: "html"});
      });
    },
  };

  return definePlugin({renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "lu_bs",
    description: "鲁小迅整点贴纸报时",
    commands: {lu_bs: {...command, helpArgs: ["help"]}},
    async setup(context) {
      await store(context).update(source => normalizeState(source));
    },
    jobs: {
      hourly_report: {
        description: "发送整点报时贴纸",
        cron: "0 * * * *",
        timeZone: TIME_ZONE,
        async handle(context, signal) {
          const snapshot = normalizeState(await store(context).read());
          if (!snapshot.subscriptions.length) return;
          let set: unknown;
          try {
            set = await getStickerSet(context);
          } catch {
            signal.throwIfAborted();
            context.log.error("lu_bs_sticker_set_failed");
            return;
          }
          const sticker = stickerForHour(set);
          if (!sticker) {
            cachedSet = undefined;
            context.log.error("lu_bs_sticker_missing");
            return;
          }
          await eachConcurrent(snapshot.subscriptions, SEND_CONCURRENCY, chatId => withChatLock(chatId, async () => {
            signal.throwIfAborted();
            const current = normalizeState(await store(context).read());
            if (!current.subscriptions.includes(chatId)) return;
            try {
              const sentId = await context.telegram.withClient(async (client, clientSignal) => {
                clientSignal.throwIfAborted();
                const previous = current.lastMessages[chatId];
                if (previous) {
                  try {
                    await client.deleteMessages(chatId, [previous], {revoke: true});
                  } catch {
                    clientSignal.throwIfAborted();
                  }
                }
                const sent = await client.sendFile(chatId, {file: sticker as any, attributes: []});
                clientSignal.throwIfAborted();
                return Number.isSafeInteger(sent?.id) && sent.id > 0 ? sent.id : undefined;
              });
              if (sentId !== undefined) {
                await store(context).update(source => {
                  const state = normalizeState(source);
                  if (state.subscriptions.includes(chatId)) state.lastMessages[chatId] = sentId;
                  return state;
                });
              }
            } catch (error) {
              signal.throwIfAborted();
              const code = errorCode(error);
              if (code === "CHAT_WRITE_FORBIDDEN" || code === "CHAT_NOT_FOUND") {
                await store(context).update(source => {
                  const state = normalizeState(source);
                  state.subscriptions = state.subscriptions.filter(id => id !== chatId);
                  delete state.lastMessages[chatId];
                  return state;
                });
                context.log.info("lu_bs_subscription_removed", {chatId, reason: code});
              } else {
                context.log.error("lu_bs_send_failed", {chatId});
              }
            }
          }));
        },
      },
    },
    cleanup() {
      cachedSet = undefined;
      loadingSet = undefined;
      chatTails.clear();
    },
  });
}
