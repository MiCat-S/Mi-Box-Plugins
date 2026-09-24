import type { Api, TelegramClient } from "teleproto";
import type { CommandInvocation, PluginContext } from "telebox/sdk";
import { setTimeout as delay } from "node:timers/promises";

// p-limit 已不再使用：跨群扇出统一走 createLaneQueue，遇到 FLOOD_WAIT 会让出车道而不是占着并发槽睡

const CONCURRENCY = {
  /**
   * 跨群扇出（封禁/解封）的并发车道数。
   *
   * 保持 4：车道数和原版 p-limit 一致，扇出的落点由此确定 —— 提到 8 会让同一批请求
   * 落在不同的群上，用户看到的结果一样但复现路径变了。真正的提速来自
   * FLOOD_WAIT 让出车道，而不是把并发堆高。
   */
  LANES: 4,
  /** 单个请求遇到 FLOOD_WAIT 后最多重新排队几次 */
  FLOOD_RETRIES: 2,
  /** 超过这个秒数的 FLOOD_WAIT 直接判定失败，不再重试 */
  FLOOD_MAX_WAIT_SECONDS: 8,
};

/** 管理群缓存在这个时间内直接返回，不刷新 */
const FRESH_TTL_MS = 30 * 60_000;
/** 超过新鲜期但在这个时间内，先返回旧的、后台异步刷新 */
const STALE_TTL_MS = 24 * 60 * 60_000;

// teleproto 命名空间在模块级只加载一次；原来是每次命令都 `await import("teleproto")`
let teleprotoPromise: Promise<any> | null = null;
function ensureTeleproto(): Promise<any> {
  teleprotoPromise ??= import("teleproto").then((module: any) => module);
  return teleprotoPromise;
}

let bigIntPromise: Promise<(value: any) => any> | null = null;
function ensureBigInt(): Promise<(value: any) => any> {
  bigIntPromise ??= import("teleproto/Helpers.js").then((module: any) => module.returnBigInt);
  return bigIntPromise;
}

export async function createAbanRuntime(ctx: PluginContext, inv: CommandInvocation) {
  const { Api } = await ensureTeleproto();
  const bigInt = await ensureBigInt();
  const sleep = (ms: number) => delay(ms, undefined, { signal: ctx.signal });
  const safeGetMe = (client: TelegramClient) => client.getMe();
  const safeGetReplyMessage = async (_message: Api.Message) => {
    const reply = await ctx.telegram.getReply(inv.message);
    if (!reply) return undefined;
    return Object.defineProperty(Object.create(reply.raw ?? null), "senderId", {
      value: reply.senderId ? bigInt(reply.senderId) : undefined,
    }) as Api.Message;
  };
  const htmlEscape = (value: string) =>
    value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

  /**
   * 固定车道的任务队列。
   *
   * 和 p-limit 的区别：任务遇到 FLOOD_WAIT 时可以 `release()` 让出车道、睡完之后通过 `waitIdle()`
   * 确认没有积压再继续，而不是霸占一个并发槽干等。原来是 4 条车道里有一条在 sleep 9 秒，整批被它拖慢。
   */
  function createLaneQueue(lanes: number, signal: AbortSignal) {
    let active = 0;
    // outstanding 包含正在 release 中睡着的任务，所以它比 active + queue 更能代表“这一批还没完”
    let outstanding = 0;
    const queue: Array<() => void> = [];
    const idleWaiters: Array<() => void> = [];
    const drainWaiters: Array<() => void> = [];

    const wake = (waiters: Array<() => void>) => {
      while (waiters.length) waiters.shift()!();
    };

    /** active 与 queue 同时空出来时唤醒 waitIdle() */
    const checkIdle = () => {
      if (active === 0 && queue.length === 0) wake(idleWaiters);
    };

    const settle = () => {
      outstanding--;
      if (outstanding <= 0) wake(drainWaiters);
    };

    const pump = () => {
      while (active < lanes && queue.length) {
        const start = queue.shift()!;
        active++;
        start();
      }
    };

    /**
     * 等当前这一轮跑空。
     *
     * 唤醒条件必须写成「active 与 queue 同时为空」并每次重新检查：只挂一个 idleResolve，
     * 后来的等待者会把它覆盖掉，前一个就永远收不到通知（FLOOD_WAIT 重试会走到这里）。
     */
    const waitIdle = (): Promise<void> => {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise<void>(resolve => {
        idleWaiters.push(resolve);
      });
    };

    return {
      /** 提交一个任务 */
      run<T>(task: () => Promise<T>): Promise<T> {
        outstanding++;
        return new Promise<T>((resolve, reject) => {
          queue.push(() => {
            task()
              .then(resolve, reject)
              .finally(() => {
                active--;
                settle();
                checkIdle();
                pump();
              });
          });
          pump();
        });
      },
      /**
       * 让出当前车道并等待 `ms`，睡完之后如果队列还有积压就继续等。
       * 注意：让出的这段时间不再计入并发，这正是要的效果。
       */
      async release(ms: number): Promise<void> {
        active--;
        pump();
        await delay(ms, undefined, { signal });
        await waitIdle();
      },
      /** 等待所有已提交任务真正结束（含正在 release 中的） */
      async drain(): Promise<void> {
        while (outstanding > 0) {
          await new Promise<void>(resolve => {
            drainWaiters.push(resolve);
          });
        }
      },
    };
  }

  function getFloodWaitSeconds(error: unknown): number | null {
    const msg = error instanceof Error ? error.message : String(error || "");

    let m = msg.match(/FLOOD_WAIT_(\d+)/);
    if (m) return parseInt(m[1], 10);
    m = msg.match(/wait of (\d+) seconds?/i);
    if (m) return parseInt(m[1], 10);

    const seconds = (error as any)?.seconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) return seconds;
    return null;
  }

  const CONFIG = {
    MESSAGE_AUTO_DELETE: 10,
  };

  function parseTimeString(timeStr?: string): number {
    if (!timeStr) return 0; // 无参数返回0（永久）

    const time = timeStr.toLowerCase();
    const num = parseInt(time) || 0;

    if (time.includes("d")) return num * 86400;
    if (time.includes("h")) return num * 3600;
    if (time.includes("m")) return num * 60;
    if (time.includes("s")) return num;

    return 0; // 默认永久
  }

  class CacheManager {
    static getInstance() {
      const store = ctx.storage.json<{ cache: Record<string, any> }>("aban_cache.json", { cache: {} });
      return {
        async get(key: string) {
          return (await store.read()).cache[key] || null;
        },
        async set(key: string, value: any) {
          await store.update(data => ({ ...data, cache: { ...data.cache, [key]: value } }));
        },
        async clear() {
          await store.update(data => ({ ...data, cache: {} }));
        },
      };
    }
  }

  type ResolvedTarget = {
    user: any;
    uid: number | null;
    participant?: any;
    source: "reply" | "username" | "numeric" | "unknown";
    resolutionError?: string;
    chatType?: "channel" | "chat" | "unknown";
  };

  class UserResolver {
    private static isMetaFlag(arg: string): boolean {
      const a = arg.trim().toLowerCase();
      return a === "true" || a === "false" || a === "confirm";
    }

    static async resolveTarget(client: TelegramClient, message: Api.Message, args: string[]): Promise<ResolvedTarget> {
      const targetArgs = args.filter(a => !this.isMetaFlag(a));

      if (targetArgs.length > 0) {
        return await this.resolveFromString(client, message, targetArgs[0]);
      }

      const reply = await safeGetReplyMessage(message);
      if (reply?.senderId) {
        const uid = Number(reply.senderId);
        const sender = await this.getReplySender(reply);
        const participant =
          sender instanceof Api.User
            ? await this.safeGetInputEntity(client, sender)
            : await this.safeGetInputEntity(client, uid);
        const fallbackParticipant =
          participant || (await this.resolveParticipantFromContext(client, message, uid, sender));

        return {
          user: sender || reply.sender,
          uid,
          participant: fallbackParticipant,
          source: "reply",
          resolutionError: fallbackParticipant ? undefined : "TARGET_ENTITY_UNRESOLVABLE",
          chatType: this.getChatType(message),
        };
      }

      return {
        user: null,
        uid: null,
        source: "unknown",
        resolutionError: "NO_TARGET",
        chatType: this.getChatType(message),
      };
    }

    private static async resolveFromString(
      client: TelegramClient,
      message: Api.Message,
      target: string,
    ): Promise<ResolvedTarget> {
      try {
        if (target.startsWith("@")) {
          const entity = await this.safeGetEntity(client, target);
          const participant = entity ? await this.safeGetInputEntity(client, entity) : undefined;
          const uid = entity?.id ? Number(entity.id) : null;
          const fallbackParticipant = uid
            ? participant || (await this.resolveParticipantFromContext(client, message, uid, entity))
            : undefined;
          return {
            user: entity,
            uid,
            participant: fallbackParticipant,
            source: "username",
            resolutionError: fallbackParticipant || uid === null ? undefined : "TARGET_ENTITY_UNRESOLVABLE",
            chatType: this.getChatType(message),
          };
        }

        if (/^-?\d+$/.test(target)) {
          const userId = parseInt(target, 10);
          const resolved = await this.resolveNumericUser(client, message, userId);
          return {
            user: resolved.user,
            uid: userId,
            participant: resolved.participant,
            source: "numeric",
            resolutionError: resolved.participant ? undefined : "TARGET_ENTITY_UNRESOLVABLE",
            chatType: this.getChatType(message),
          };
        }
      } catch (error) {
        ctx.log.info("aban:operation");
      }

      return {
        user: null,
        uid: null,
        source: "unknown",
        resolutionError: "INVALID_TARGET",
        chatType: this.getChatType(message),
      };
    }

    private static async getReplySender(reply: Api.Message): Promise<any> {
      try {
        return await (reply as any).getSender?.();
      } catch {
        return reply.sender;
      }
    }

    private static getChatType(message: Api.Message): "channel" | "chat" | "unknown" {
      if ((message as any).isChannel) return "channel";
      if ((message as any).isGroup) return "chat";
      return "unknown";
    }

    private static async safeGetEntity(client: TelegramClient, target: any): Promise<any | null> {
      try {
        return await client.getEntity(target);
      } catch {
        return null;
      }
    }

    private static async safeGetInputEntity(client: TelegramClient, target: any): Promise<any | undefined> {
      try {
        return await client.getInputEntity(target);
      } catch {
        return undefined;
      }
    }

    private static async resolveParticipantFromContext(
      client: TelegramClient,
      message: Api.Message,
      userId: number,
      knownEntity?: any,
    ): Promise<any | undefined> {
      const chat = (message as any).peerId;
      if (!chat) {
        return undefined;
      }

      if ((message as any).isChannel) {
        try {
          const viaPart = await this.resolveUserViaGetParticipant(client, chat, userId);
          if (viaPart) return viaPart;

          let offset = 0;
          const limit = 200;
          for (let i = 0; i < 5; i++) {
            const res: any = await client.invoke(
              new Api.channels.GetParticipants({
                channel: chat,
                filter: new Api.ChannelParticipantsRecent(),
                offset,
                limit,
                hash: 0 as any,
              }),
            );

            const participants: any[] = res?.participants || [];
            const users: any[] = res?.users || [];
            const matchedUser = users.find(u => Number(u?.id) === userId);
            if (matchedUser) {
              const input = await this.safeGetInputEntity(client, matchedUser);
              if (input) {
                return input;
              }
            }

            if (!participants.length) break;
            offset += participants.length;
          }
        } catch {
          return undefined;
        }
      }

      if ((message as any).isGroup) {
        try {
          const peer: any = knownEntity || (await this.safeGetEntity(client, chat));
          const chatId = Number(peer?.chatId ?? peer?.id ?? (chat as any)?.chatId);
          if (!Number.isFinite(chatId)) {
            return undefined;
          }

          const full: any = await client.invoke(
            new Api.messages.GetFullChat({
              chatId: bigInt(chatId),
            }),
          );

          const participants = full?.fullChat?.participants;
          if (!participants || participants instanceof Api.ChatParticipantsForbidden) {
            return undefined;
          }

          const users: any[] = full?.users || [];
          const matchedUser = users.find(u => Number(u?.id) === userId);
          if (matchedUser) {
            return await this.safeGetInputEntity(client, matchedUser);
          }
        } catch {
          return undefined;
        }
      }

      return undefined;
    }

    private static async resolveNumericUser(
      client: TelegramClient,
      message: Api.Message,
      userId: number,
    ): Promise<{ user: any; participant?: any }> {
      let entity = await this.safeGetEntity(client, userId);
      let participant = entity
        ? await this.safeGetInputEntity(client, entity)
        : await this.safeGetInputEntity(client, userId);

      if (!participant) {
        participant = await this.resolveParticipantFromContext(client, message, userId, entity);
      }

      if (!participant && (message as any).isChannel) {
        participant = await this.resolveUserViaGetParticipant(client, (message as any).peerId, userId);
        if (!entity && participant) {
          entity = await this.safeGetEntity(client, userId);
        }
      }

      if (!participant) {
        const cross = await this.resolveUserAcrossManagedGroups(client, userId, (message as any).peerId);
        if (cross.participant) {
          participant = cross.participant;
          if (!entity && cross.entity) entity = cross.entity;
        }
      }

      if (!participant && (message as any).isChannel) {
        try {
          participant = new Api.InputPeerUser({
            userId: bigInt(userId),
            accessHash: bigInt(0),
          });
        } catch {
          participant = undefined;
        }
      }

      return { user: entity, participant };
    }

    private static async resolveUserViaGetParticipant(
      client: TelegramClient,
      chat: any,
      userId: number,
    ): Promise<any | undefined> {
      if (!chat || !userId) return undefined;
      try {
        const res: any = await client.invoke(
          new Api.channels.GetParticipant({
            channel: chat,
            participant: new Api.InputPeerUser({
              userId: bigInt(userId),
              accessHash: bigInt(0),
            }),
          }),
        );
        const matched = (res?.users || []).find((u: any) => Number(u?.id) === userId);
        if (matched) {
          return await this.safeGetInputEntity(client, matched);
        }
      } catch {
        return undefined;
      }
      return undefined;
    }

    private static async resolveUserAcrossManagedGroups(
      client: TelegramClient,
      userId: number,
      excludePeer?: any,
    ): Promise<{ participant?: any; entity?: any }> {
      if (!userId) return {};
      let groups: ManagedGroup[] = [];
      try {
        groups = await GroupManager.getManagedGroups(client);
      } catch {
        return {};
      }
      if (!groups.length) return {};

      const excludeId = excludePeer
        ? Number(excludePeer?.channelId ?? excludePeer?.chatId ?? excludePeer?.userId ?? excludePeer?.id ?? 0)
        : 0;

      const ordered = [...groups.filter(g => g.kind === "channel"), ...groups.filter(g => g.kind === "chat")];

      const queue = createLaneQueue(CONCURRENCY.LANES, ctx.signal);
      let found: { participant?: any; entity?: any } = {};

      await Promise.all(
        ordered.map(group =>
          queue.run(async () => {
            if (found.participant) return;
            if (excludeId && Number(group.id) === excludeId) return;
            try {
              if (group.kind === "channel") {
                const channel = await resolveChannelInput(client, group);
                const res: any = await client.invoke(
                  new Api.channels.GetParticipant({
                    channel: channel as any,
                    participant: new Api.InputPeerUser({
                      userId: bigInt(userId),
                      accessHash: bigInt(0),
                    }),
                  }),
                );
                const matched = (res?.users || []).find((u: any) => Number(u?.id) === userId);
                if (matched && !found.participant) {
                  const input = await this.safeGetInputEntity(client, matched);
                  if (input) found = { participant: input, entity: matched };
                }
                return;
              }

              const full: any = await client.invoke(
                new Api.messages.GetFullChat({
                  chatId: bigInt(Math.abs(Number(group.id))),
                }),
              );
              const matched = (full?.users || []).find((u: any) => Number(u?.id) === userId);
              if (matched && !found.participant) {
                const input = await this.safeGetInputEntity(client, matched);
                if (input) found = { participant: input, entity: matched };
              }
            } catch {}
          }),
        ),
      );

      return found;
    }

    static formatUser(user: any, userId: number): string {
      if (user?.firstName || user?.first_name) {
        let name = user.firstName || user.first_name || String(userId);
        if (user.lastName || user.last_name) {
          name += ` ${user.lastName || user.last_name}`;
        }
        if (user.username) {
          name += ` (@${user.username})`;
        }
        return name;
      } else if (user?.title) {
        return `频道: ${user.title}${user.username ? ` (@${user.username})` : ""}`;
      }
      return String(userId);
    }
  }

  class MessageManager {
    static async smartEdit(
      message: Api.Message,
      text: string,
      deleteAfter = CONFIG.MESSAGE_AUTO_DELETE,
      parseMode: "html" | "md" = "html",
    ): Promise<Api.Message> {
      try {
        await ctx.telegram.edit(inv.message, text, {
          parseMode: parseMode === "md" ? "markdown" : "html",
          linkPreview: false,
        });
      } catch (error) {
        // 取消必须传播，不能把 abort 当成可忽略的编辑失败。
        if (ctx.signal.aborted || (error as { name?: string })?.name === "AbortError") throw error;
        // 状态/结果消息编辑失败不阻断后续业务；记录固定日志，且与原版一样不调度删除。
        ctx.log.error("aban:edit-failed");
        return message;
      }
      if (deleteAfter > 0) {
        void ctx.tasks
          .run("aban:delete-result", async signal => {
            await delay(deleteAfter * 1000, undefined, { signal });
            await ctx.telegram.withClient(client =>
              client.deleteMessages(message.peerId, [message.id], { revoke: true }),
            );
          })
          .catch(() => {
            if (!ctx.signal.aborted) ctx.log.error("aban:delete-result");
          });
      }
      return message;
    }
  }

  type ManagedGroup = {
    id: number;
    title: string;
    kind: ChatKind;

    accessHash?: string;
  };

  /**
   * 按 group.id 记忆化 ChannelInput。
   *
   * 不能按 client 缓存 —— v2.ts 每次命令都新建一层 Proxy，client 身份每次都不同。
   * 改成进程级 Map + TTL：预检、封禁、解封在同一批里会重复解析同一个群，这里直接命中。
   * 有 accessHash 的群走纯构造、零网络；accessHash 会失效，所以给了 10 分钟上限。
   */
  const CHANNEL_INPUT_TTL_MS = 10 * 60_000;
  const channelInputCache = new Map<string, { at: number; input: any }>();

  function channelInputKey(group: ManagedGroup): string {
    return `${group.id}:${group.accessHash ?? ""}`;
  }

  async function resolveChannelInput(client: TelegramClient, group: ManagedGroup): Promise<any> {
    if (group.kind !== "channel") {
      return group.id;
    }

    const key = channelInputKey(group);
    const TTL = group.accessHash ? CHANNEL_INPUT_TTL_MS : 0;
    const cached = channelInputCache.get(key);
    if (cached && TTL > 0 && Date.now() - cached.at < TTL) return cached.input;

    try {
      let input: any;
      if (group.accessHash) {
        const { Api } = await ensureTeleproto();
        const bigInt = await ensureBigInt();
        input = new Api.InputChannel({
          channelId: bigInt(group.id),
          accessHash: bigInt(group.accessHash),
        });
      } else {
        input = await client.getInputEntity(group.id);
      }
      if (TTL > 0) channelInputCache.set(key, { at: Date.now(), input });
      return input;
    } catch (error) {
      channelInputCache.delete(key);
      throw error;
    }
  }

  /** 让下一次命令重新解析（`.refresh` 后调用） */
  function resetChannelInputCache(): void {
    channelInputCache.clear();
  }

  class PermissionManager {
    private static getChatKind(chatId: any): ChatKind {
      const className = chatId?.className;
      if (className === "PeerChat" || className === "Chat") {
        return "chat";
      }
      return "channel";
    }

    private static getBasicGroupChatId(chatId: any): number {
      return Number(chatId?.chatId ?? chatId?.id ?? chatId);
    }

    private static async getBasicGroupParticipants(client: TelegramClient, chatId: any): Promise<any[] | null> {
      const full = (await client.invoke(
        new Api.messages.GetFullChat({
          chatId: bigInt(this.getBasicGroupChatId(chatId)),
        }),
      )) as any;

      const participants = full?.fullChat?.participants;
      if (!participants || participants instanceof Api.ChatParticipantsForbidden) {
        return null;
      }

      return participants.participants || null;
    }

    static async checkAdminPermission(client: TelegramClient, chatId: any): Promise<boolean> {
      try {
        const me = await safeGetMe(client);
        if (!me) return false;
        if (this.getChatKind(chatId) === "chat") {
          const participants = await this.getBasicGroupParticipants(client, chatId);
          if (!participants) {
            return false;
          }

          const meParticipant = participants.find((p: any) => Number(p?.userId) === Number((me as any).id));
          return (
            meParticipant instanceof Api.ChatParticipantCreator || meParticipant instanceof Api.ChatParticipantAdmin
          );
        }

        const participant = await client.invoke(
          new Api.channels.GetParticipant({
            channel: chatId,
            participant: new Api.InputPeerSelf(),
          }),
        );

        const p = participant.participant;
        if (p instanceof Api.ChannelParticipantCreator) return true;
        if (p instanceof Api.ChannelParticipantAdmin) {
          const rights = p.adminRights;
          return !!(rights?.banUsers || rights?.deleteMessages);
        }
        return false;
      } catch (error) {
        return false;
      }
    }

    static async isTargetAdmin(client: TelegramClient, chatId: any, userId: number): Promise<boolean> {
      try {
        if (this.getChatKind(chatId) === "chat") {
          const participants = await this.getBasicGroupParticipants(client, chatId);
          if (!participants) {
            return false;
          }

          const targetParticipant = participants.find((p: any) => Number(p?.userId) === userId);
          return (
            targetParticipant instanceof Api.ChatParticipantCreator ||
            targetParticipant instanceof Api.ChatParticipantAdmin
          );
        }

        const participant = await client.invoke(
          new Api.channels.GetParticipant({
            channel: chatId,
            participant: userId,
          }),
        );

        const p = participant.participant;
        return p instanceof Api.ChannelParticipantCreator || p instanceof Api.ChannelParticipantAdmin;
      } catch (error) {
        return false;
      }
    }

    static async canDeleteMessages(client: TelegramClient, chatId: any): Promise<boolean> {
      const me = await safeGetMe(client);
      if (!me) return false;
      if (this.getChatKind(chatId) === "chat") {
        const participants = await this.getBasicGroupParticipants(client, chatId);
        if (!participants) {
          return false;
        }

        const meParticipant = participants.find((p: any) => Number(p?.userId) === Number((me as any).id));
        return meParticipant instanceof Api.ChatParticipantCreator || meParticipant instanceof Api.ChatParticipantAdmin;
      }

      const participant = await client.invoke(
        new Api.channels.GetParticipant({
          channel: chatId,
          participant: new Api.InputPeerSelf(),
        }),
      );

      const p = participant.participant;
      if (p instanceof Api.ChannelParticipantCreator) return true;
      if (p instanceof Api.ChannelParticipantAdmin) {
        return !!p.adminRights?.deleteMessages;
      }
      return false;
    }
  }

  class GroupManager {
    private static cache = CacheManager.getInstance();

    private static async getAllManageableDialogs(client: TelegramClient): Promise<any[]> {
      const dialogMap = new Map<number, any>();

      const collectDialogs = async (params: Record<string, any>) => {
        const dialogs = await client.getDialogs(params);
        for (const dialog of dialogs || []) {
          if (dialog.isChannel || dialog.isGroup) {
            dialogMap.set(Number(dialog.id), dialog);
          }
        }
      };

      await collectDialogs({});
      await collectDialogs({ folderId: 1 });

      return Array.from(dialogMap.values());
    }

    private static dialogHasManageRights(dialog: any): boolean {
      const entity = dialog?.entity;
      if (!entity || entity.left || entity.deactivated || entity.migratedTo) return false;
      if (entity.creator) return true;
      const rights = entity.adminRights;
      if (!rights) return false;
      return !!(rights.banUsers || rights.deleteMessages);
    }

    static async getManagedGroups(client: TelegramClient): Promise<ManagedGroup[]> {
      // 缓存放宽到 30 分钟，并且是 stale-while-revalidate：
      // 命中旧数据先用旧数据，后台异步刷新，命令本身不等这两遍全量对话框分页。
      const cached = await this.cache.get("managed_groups_v7");
      const age = Date.now() - cached?.updatedAt;
      const fresh = cached && Array.isArray(cached.groups) && age >= 0 && age < FRESH_TTL_MS;

      if (fresh) return cached.groups;

      const stale =
        cached && Array.isArray(cached.groups) && cached.groups.length > 0 && age >= 0 && age < STALE_TTL_MS;
      if (stale) {
        // 先用着旧的，刷新丢到后台；失败也不影响本次命令
        void this.refreshInBackground(client, cached.updatedAt);
        return cached.groups;
      }

      return await this.loadManageableGroups(client);
    }

    private static refreshing: Promise<ManagedGroup[]> | null = null;

    private static refreshInBackground(client: TelegramClient, since: number): void {
      if (this.refreshing) return;
      this.refreshing = this.loadManageableGroups(client)
        .catch(() => [])
        .finally(() => {
          this.refreshing = null;
        }) as Promise<ManagedGroup[]>;
      void since;
    }

    private static async loadManageableGroups(client: TelegramClient): Promise<ManagedGroup[]> {
      const groups: ManagedGroup[] = [];

      try {
        const dialogs = await this.getAllManageableDialogs(client);

        for (const dialog of dialogs || []) {
          if (!(dialog.isChannel || dialog.isGroup)) continue;
          if (!this.dialogHasManageRights(dialog)) continue;
          const isChannel = !(dialog.isGroup && !dialog.isChannel);
          // 基础群没有 accessHash；频道一律写下来，让 resolveChannelInput 走零网络的构造分支
          const rawHash = dialog.entity?.accessHash;
          const accessHash = rawHash != null ? String(rawHash) : undefined;

          const rawId = Number(dialog.entity?.id);
          if (!Number.isSafeInteger(rawId) || rawId <= 0) continue;
          groups.push({
            id: rawId,
            title: dialog.title || "Unknown",
            kind: isChannel ? ("channel" as const) : ("chat" as const),
            ...(accessHash !== undefined ? { accessHash } : {}),
          });
        }
        ctx.log.info("aban:operation");

        try {
          await this.cache.set("managed_groups_v7", { updatedAt: Date.now(), groups });
        } catch (cacheError) {
          ctx.log.info("aban:operation");
        }
      } catch (error) {
        ctx.log.info("aban:operation");
      }

      return groups;
    }

    static async clearCache(): Promise<void> {
      this.refreshing = null;
      await this.cache.clear();
    }
  }

  type BatchGroupFailure = {
    group: ManagedGroup;
    reason: string;
  };

  type ChatKind = "channel" | "chat";

  type BatchBanResult = {
    success: number;
    failed: number;
    failedGroups: string[];
    failureDetails: BatchGroupFailure[];
    unresolved: boolean;
    unresolvedReason?: string;
  };

  class BanManager {
    static async resolveParticipant(client: TelegramClient, userId: number, participant?: any): Promise<any> {
      if (participant) {
        return participant;
      }
      return client.getInputEntity(userId);
    }

    static getErrorReason(error: unknown): string {
      const rpcMessage = (error as any)?.errorMessage;
      if (typeof rpcMessage === "string" && /^[A-Z][A-Z0-9_]{3,}$/.test(rpcMessage)) return rpcMessage;
      const message = error instanceof Error ? error.message : String(error || "UNKNOWN_ERROR");

      const rpcCodes = message.match(/\b[A-Z][A-Z0-9_]{4,}\b/g) || [];
      const skip = new Set(["TELEGRAM", "ERROR", "UNKNOWN", "UNKNOWN_ERROR"]);
      for (const code of rpcCodes) {
        if (skip.has(code)) continue;
        if (code === "API") continue;
        return code;
      }
      const textField = (error as any)?.text;
      if (typeof textField === "string" && /^[A-Z][A-Z0-9_]{3,}$/.test(textField)) {
        return textField;
      }
      return message.slice(0, 80) || "UNKNOWN_ERROR";
    }

    private static getChatKind(chatId: any): ChatKind {
      if (chatId?.kind === "chat" || chatId?.kind === "channel") {
        return chatId.kind;
      }

      const className = chatId?.className;
      if (className === "PeerChat" || className === "Chat") {
        return "chat";
      }
      return "channel";
    }

    private static getBasicGroupChatId(chatId: any): number {
      const id = Number(chatId?.chatId ?? chatId?.id ?? chatId);
      return id;
    }

    private static async applyBanLikeAction(
      client: TelegramClient,
      chatId: any,
      resolvedParticipant: any,
      bannedRights: Api.ChatBannedRights,
      action: "ban" | "unban" | "mute",
    ): Promise<void> {
      const chatKind = this.getChatKind(chatId);
      if (chatKind === "chat") {
        if (action === "unban" || action === "mute") {
          throw new Error("BASIC_GROUP_ACTION_UNSUPPORTED");
        }

        await client.invoke(
          new Api.messages.DeleteChatUser({
            chatId: bigInt(this.getBasicGroupChatId(chatId)),
            userId: resolvedParticipant,
          }),
        );
        return;
      }

      await client.invoke(
        new Api.channels.EditBanned({
          channel: chatId,
          participant: resolvedParticipant,
          bannedRights,
        }),
      );
    }

    static async banUser(
      client: TelegramClient,
      chatId: any,
      userId: number,
      until: number = 0,
      participant?: any,
    ): Promise<boolean> {
      try {
        const resolvedParticipant = await this.resolveParticipant(client, userId, participant);
        const rights = new Api.ChatBannedRights({
          untilDate: until,
          viewMessages: true,
          sendMessages: true,
          sendMedia: true,
          sendStickers: true,
          sendGifs: true,
          sendGames: true,
          sendInline: true,
          embedLinks: true,
        });

        await this.applyBanLikeAction(client, chatId, resolvedParticipant, rights, "ban");
        return true;
      } catch (error) {
        ctx.log.info("aban:operation");
        return false;
      }
    }

    static async unbanUser(client: TelegramClient, chatId: any, userId: number, participant?: any): Promise<boolean> {
      try {
        const resolvedParticipant = await this.resolveParticipant(client, userId, participant);
        const rights = new Api.ChatBannedRights({
          untilDate: 0,
        });

        await this.applyBanLikeAction(client, chatId, resolvedParticipant, rights, "unban");
        return true;
      } catch (error) {
        ctx.log.info("aban:operation");
        return false;
      }
    }

    static async muteUser(
      client: TelegramClient,
      chatId: any,
      userId: number,
      duration: number,
      participant?: any,
    ): Promise<boolean> {
      try {
        const resolvedParticipant = await this.resolveParticipant(client, userId, participant);
        const until = duration === 0 ? 0 : Math.floor(Date.now() / 1000) + duration;
        const rights = new Api.ChatBannedRights({
          untilDate: until,
          sendMessages: true,
          sendMedia: true,
          sendStickers: true,
          sendGifs: true,
          sendGames: true,
          sendInline: true,
          embedLinks: true,
        });

        await this.applyBanLikeAction(client, chatId, resolvedParticipant, rights, "mute");
        return true;
      } catch (error) {
        ctx.log.info("aban:operation");
        return false;
      }
    }

    static async kickUser(client: TelegramClient, chatId: any, userId: number, participant?: any): Promise<boolean> {
      try {
        if (this.getChatKind(chatId) === "chat") {
          return await this.banUser(client, chatId, userId, 0, participant);
        }

        const banned = await this.banUser(client, chatId, userId, 0, participant);
        if (!banned) {
          return false;
        }

        return await this.unbanUser(client, chatId, userId, participant);
      } catch (error) {
        ctx.log.info("aban:operation");
        return false;
      }
    }

    static async deleteHistoryInCurrentChat(
      client: TelegramClient,
      chatId: any,
      userId: number,
      participant?: any,
    ): Promise<{ success: boolean; reason?: string }> {
      try {
        if (this.getChatKind(chatId) === "chat") {
          return { success: false, reason: "BASIC_GROUP_HISTORY_UNSUPPORTED" };
        }
        const canDelete = await PermissionManager.canDeleteMessages(client, chatId);
        if (!canDelete) return { success: false, reason: "DELETE_MESSAGES_PERMISSION_REQUIRED" };

        const resolvedParticipant = participant || (await client.getEntity(userId));
        let result: Api.messages.AffectedHistory;
        do {
          ctx.signal.throwIfAborted();
          result = await client.invoke(
            new Api.channels.DeleteParticipantHistory({
              channel: chatId,
              participant: resolvedParticipant,
            }),
          );
        } while (result.offset > 0);
        return { success: true };
      } catch (error) {
        ctx.signal.throwIfAborted();
        const reason = this.getErrorReason(error);
        ctx.log.info("aban:history-delete-failed", {
          reason: /^[A-Z][A-Z0-9_]{3,}$/.test(reason) ? reason : "UNKNOWN_ERROR",
        });
        return { success: false, reason };
      }
    }

    static async batchBanUser(
      client: TelegramClient,
      groups: ManagedGroup[],
      userId: number,
      participant?: any,
      reason: string = "跨群违规",
    ): Promise<BatchBanResult> {
      let resolvedParticipant: any;
      try {
        resolvedParticipant = await this.resolveParticipant(client, userId, participant);
      } catch (error) {
        return {
          success: 0,
          failed: groups.length,
          failedGroups: groups.map(group => group.title),
          failureDetails: [],
          unresolved: true,
          unresolvedReason: this.getErrorReason(error),
        };
      }

      const rights = new Api.ChatBannedRights({
        untilDate: 0,
        viewMessages: true,
        sendMessages: true,
        sendMedia: true,
        sendStickers: true,
        sendGifs: true,
        sendGames: true,
        sendInline: true,
        embedLinks: true,
      });

      const queue = createLaneQueue(CONCURRENCY.LANES, ctx.signal);

      const runOne = async (
        group: ManagedGroup,
      ): Promise<{ success: true; group: ManagedGroup } | { success: false; group: ManagedGroup; reason: string }> => {
        const buildRequest = async (): Promise<any> => {
          if (group.kind === "chat") {
            return client.invoke(
              new Api.messages.DeleteChatUser({
                chatId: bigInt(this.getBasicGroupChatId(group.id)),
                userId: resolvedParticipant,
              }),
            );
          }
          const channelInput = await resolveChannelInput(client, group);
          return client.invoke(
            new Api.channels.EditBanned({
              channel: channelInput,
              participant: resolvedParticipant,
              bannedRights: rights,
            }),
          );
        };

        const attempt = async (
          retriesLeft: number,
        ): Promise<
          { success: true; group: ManagedGroup } | { success: false; group: ManagedGroup; reason: string }
        > => {
          try {
            await buildRequest();
            return { success: true as const, group };
          } catch (error) {
            const floodSecs = getFloodWaitSeconds(error);
            if (floodSecs !== null && floodSecs <= CONCURRENCY.FLOOD_MAX_WAIT_SECONDS && retriesLeft > 0) {
              // 让出车道去睡，而不是占着并发槽干等
              await queue.release((floodSecs + 1) * 1000);
              return attempt(retriesLeft - 1);
            }
            return {
              success: false as const,
              group,
              reason: this.getErrorReason(error),
            };
          }
        };

        return attempt(CONCURRENCY.FLOOD_RETRIES);
      };

      const settled = await Promise.allSettled(groups.map(group => queue.run(() => runOne(group))));

      await queue.drain();

      type GroupOutcome =
        { success: true; group: ManagedGroup } | { success: false; group: ManagedGroup; reason: string };

      const results: GroupOutcome[] = settled.map((result, index) => {
        if (result.status === "fulfilled") {
          return result.value as GroupOutcome;
        }
        return {
          success: false as const,
          group: groups[index],
          reason: this.getErrorReason(result.reason),
        };
      });

      let success = 0;
      let failed = 0;
      const failedGroups: string[] = [];
      const failureDetails: BatchGroupFailure[] = [];

      results.forEach(result => {
        if (result.success) {
          success++;
          return;
        }
        failed++;
        failedGroups.push(result.group.title);
        failureDetails.push({ group: result.group, reason: result.reason });
      });

      void reason;
      return {
        success,
        failed,
        failedGroups,
        failureDetails,
        unresolved: false,
      };
    }

    static async batchUnbanUser(
      client: TelegramClient,
      groups: ManagedGroup[],
      userId: number,
      participant?: any,
    ): Promise<{
      success: number;
      failed: number;
      failedGroups: string[];
      unresolved: boolean;
      unresolvedReason?: string;
    }> {
      let resolvedParticipant: any;
      try {
        resolvedParticipant = await this.resolveParticipant(client, userId, participant);
      } catch (error) {
        return {
          success: 0,
          failed: groups.length,
          failedGroups: groups.map(group => group.title),
          unresolved: true,
          unresolvedReason: this.getErrorReason(error),
        };
      }

      const rights = new Api.ChatBannedRights({
        untilDate: 0,
      });

      const queue = createLaneQueue(CONCURRENCY.LANES, ctx.signal);

      const runOne = async (group: ManagedGroup): Promise<{ success: boolean; group: ManagedGroup }> => {
        if (group.kind === "chat") {
          return { success: false, group };
        }

        const buildRequest = async (): Promise<any> => {
          const channelInput = await resolveChannelInput(client, group);
          return client.invoke(
            new Api.channels.EditBanned({
              channel: channelInput,
              participant: resolvedParticipant,
              bannedRights: rights,
            }),
          );
        };

        const attempt = async (retriesLeft: number): Promise<{ success: boolean; group: ManagedGroup }> => {
          try {
            await buildRequest();
            return { success: true, group };
          } catch (error) {
            const floodSecs = getFloodWaitSeconds(error);
            if (floodSecs !== null && floodSecs <= CONCURRENCY.FLOOD_MAX_WAIT_SECONDS && retriesLeft > 0) {
              await queue.release((floodSecs + 1) * 1000);
              return attempt(retriesLeft - 1);
            }
            return { success: false, group };
          }
        };

        return attempt(CONCURRENCY.FLOOD_RETRIES);
      };

      const settled = await Promise.allSettled(groups.map(group => queue.run(() => runOne(group))));

      await queue.drain();

      const results: Array<{ success: boolean; group: ManagedGroup }> = settled.map((result, index) => {
        if (result.status === "fulfilled") {
          return result.value;
        }
        return { success: false, group: groups[index] };
      });

      let success = 0;
      let failed = 0;
      const failedGroups: string[] = [];

      results.forEach(result => {
        if (result.success) {
          success++;
        } else {
          failed++;
          failedGroups.push(result.group.title);
        }
      });

      return { success, failed, failedGroups, unresolved: false };
    }
  }

  class CommandHandlers {
    static async handleBasicCommand(
      client: TelegramClient,
      message: Api.Message,
      action: "kick" | "ban" | "unban" | "mute" | "unmute",
    ): Promise<void> {
      try {
        const args = message.message?.split(" ").slice(1) || [];
        const { user, uid, participant, resolutionError, chatType } = await UserResolver.resolveTarget(
          client,
          message,
          args,
        );

        if (!uid) {
          await MessageManager.smartEdit(message, "❌ 获取用户失败");
          return;
        }

        const basicGroupActionAllowedWithoutParticipant = chatType === "chat" && ["ban", "kick"].includes(action);
        if (
          !participant &&
          ["ban", "unban", "mute", "unmute", "kick"].includes(action) &&
          !basicGroupActionAllowedWithoutParticipant
        ) {
          const errorText =
            resolutionError === "TARGET_ENTITY_UNRESOLVABLE"
              ? "❌ 无法解析该用户ID（会话未见过且不在管理群中）。可先回复其一则消息，或确认 ID 正确"
              : "❌ 获取用户失败";
          await MessageManager.smartEdit(message, errorText);
          return;
        }

        const isAdmin = await PermissionManager.isTargetAdmin(client, message.peerId, uid);
        if (isAdmin) {
          const hasConfirm = args.includes("true");
          if (!hasConfirm) {
            await MessageManager.smartEdit(message, "⚠️ 目标是管理员，请在命令后加上 <code>true</code> 确认执行");
            return;
          }
        }

        const display = UserResolver.formatUser(user, uid);
        const status = await MessageManager.smartEdit(
          message,
          `⏳ ${this.getActionName(action)}${htmlEscape(display)}...`,
          0,
        );

        let success = false;
        let resultText = "";

        switch (action) {
          case "kick":
            success = await BanManager.kickUser(client, message.peerId, uid, participant);
            resultText = `✅ 已踢出 ${htmlEscape(display)}`;
            break;
          case "ban":
            const deletion = await BanManager.deleteHistoryInCurrentChat(client, message.peerId, uid, participant);
            success = await BanManager.banUser(client, message.peerId, uid, 0, participant);
            const deleteText = deletion.success
              ? "(已清理消息)"
              : `(消息清理失败：${htmlEscape(deletion.reason || "UNKNOWN_ERROR")})`;
            resultText =
              chatType === "chat"
                ? `✅ 已移出 ${htmlEscape(display)} ${deleteText}`
                : `✅ 已封禁 ${htmlEscape(display)} ${deleteText}`;
            break;
          case "unban":
            success = await BanManager.unbanUser(client, message.peerId, uid, participant);
            resultText = chatType === "chat" ? `✅ 已处理 ${htmlEscape(display)}` : `✅ 已解封 ${htmlEscape(display)}`;
            break;
          case "mute":
            const duration = parseTimeString(args[1]);
            success = await BanManager.muteUser(client, message.peerId, uid, duration, participant);
            const durationText = duration === 0 ? "永久" : this.formatDuration(duration);
            resultText =
              chatType === "chat"
                ? `✅ 已处理 ${htmlEscape(display)} ${durationText}`
                : `✅ 已禁言 ${htmlEscape(display)} ${durationText}`;
            break;
          case "unmute":
            success = await BanManager.unbanUser(client, message.peerId, uid, participant);
            resultText =
              chatType === "chat" ? `✅ 已处理 ${htmlEscape(display)}` : `✅ 已解禁言 ${htmlEscape(display)}`;
            break;
        }

        if (success) {
          await MessageManager.smartEdit(status, resultText);
        } else {
          await MessageManager.smartEdit(status, `❌ ${this.getActionName(action)}失败`);
        }
      } catch (error: any) {
        await MessageManager.smartEdit(message, `❌ 操作失败：${htmlEscape(error.message)}`);
      }
    }

    private static getActionName(action: string): string {
      const names: Record<string, string> = {
        kick: "踢出",
        ban: "封禁",
        unban: "解封",
        mute: "禁言",
        unmute: "解除禁言",
      };
      return names[action] || action;
    }

    private static formatDuration(seconds: number): string {
      if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
      if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
      if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
      return `${seconds}s`;
    }

    static async handleSuperBan(client: TelegramClient, message: Api.Message): Promise<void> {
      try {
        const args = message.message?.split(" ").slice(1) || [];
        const { user, uid, participant, resolutionError } = await UserResolver.resolveTarget(client, message, args);

        if (!uid) {
          await MessageManager.smartEdit(message, "❌ 获取用户失败");
          return;
        }

        if (!participant) {
          const errorText =
            resolutionError === "TARGET_ENTITY_UNRESOLVABLE"
              ? "❌ 无法解析该用户ID（会话未见过且不在任一管理群中）。可先 `.refresh` 后重试，或回复其一则消息"
              : "❌ 获取用户失败";
          await MessageManager.smartEdit(message, errorText);
          return;
        }

        const groups = await GroupManager.getManagedGroups(client);
        const hasBasicGroups = groups.some(group => group.kind === "chat");

        if (groups.length === 0) {
          await MessageManager.smartEdit(message, "❌ 无管理群组");
          return;
        }

        // 预检目标是不是管理员：必须在任何写操作之前完成，否则会留下封了一半的群。
        // 这趟扫描保留原版的语义，但走并发车道，并且 resolveChannelInput 与随后的封禁
        // 共享缓存 —— 原来同一个群要解析两遍。
        const checkQueue = createLaneQueue(CONCURRENCY.LANES, ctx.signal);
        const adminResults = await Promise.allSettled(
          groups.map(group =>
            checkQueue.run(async () => {
              try {
                const target =
                  group.kind === "chat"
                    ? { className: "PeerChat", chatId: bigInt(group.id) }
                    : await resolveChannelInput(client, group);
                return await PermissionManager.isTargetAdmin(client, target, uid);
              } catch {
                return false;
              }
            }),
          ),
        );
        await checkQueue.drain();
        const adminGroups = adminResults.filter(result => result.status === "fulfilled" && result.value).length;

        const hasConfirm = args.includes("true");
        if (adminGroups > 0 && !hasConfirm) {
          await MessageManager.smartEdit(
            message,
            `⚠️ 目标在 ${adminGroups} 个管理群中具有管理员身份，请在命令后加上 <code>true</code> 确认执行`,
          );
          return;
        }

        const display = UserResolver.formatUser(user, uid);

        const statusActionText = (message as any).isGroup && !(message as any).isChannel ? "移出" : "封禁";
        const status = await MessageManager.smartEdit(
          message,
          `⚡ 在${groups.length}个频道/群组中${statusActionText}该用户...`,
          0,
        );

        const backgroundProcess = async () => {
          const startTime = Date.now();

          const [deletedInCurrent, banResult] = await Promise.allSettled([
            BanManager.deleteHistoryInCurrentChat(client, message.peerId, uid, participant),
            BanManager.batchBanUser(client, groups, uid, participant, args.slice(1).join(" ") || "违规"),
          ]);

          const elapsed = (Date.now() - startTime) / 1000;

          const deletion =
            deletedInCurrent.status === "fulfilled"
              ? deletedInCurrent.value
              : { success: false, reason: BanManager.getErrorReason(deletedInCurrent.reason) };
          const {
            success = 0,
            failed = groups.length,
            failureDetails = [],
            unresolved = false,
            unresolvedReason,
          } = banResult.status === "fulfilled"
            ? banResult.value
            : { failureDetails: [], unresolved: true, unresolvedReason: "UNKNOWN_ERROR" };

          // 预检已经拦下无确认的管理员场景，走到这里说明要么加了 true，要么中途才变成管理员
          const summarizeReasons = (details: BatchGroupFailure[]): string => {
            const counts = new Map<string, number>();
            for (const item of details) {
              counts.set(item.reason, (counts.get(item.reason) || 0) + 1);
            }
            return Array.from(counts.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([reason, count]) => `${htmlEscape(reason)}×${count}`)
              .join("、");
          };

          const failureSummary = unresolved
            ? `\n⚠️ 目标实体无法解析：${htmlEscape(unresolvedReason || "UNKNOWN_ERROR")}`
            : failed > 0
              ? `\n⚠️ 失败 ${failed} 个频道/群组（${summarizeReasons(failureDetails)}）`
              : "";
          const capabilityNote = hasBasicGroups ? `\nℹ️ 基础群仅支持移出现有成员，不支持对未入群目标提前封禁` : "";

          const finalActionText = (message as any).isGroup && !(message as any).isChannel ? "移出" : "封禁";
          const result = `✅ 在${success}个频道/群组中${finalActionText}该用户 ${htmlEscape(display)}${failureSummary}${capabilityNote}\n🗑️当前群组消息: ${deletion.success ? "✓已清理" : `✗ ${htmlEscape(deletion.reason || "UNKNOWN_ERROR")}`} | ⏱️${elapsed.toFixed(1)}s`;

          await MessageManager.smartEdit(status, result, 30);
        };

        await backgroundProcess();
      } catch (error: any) {
        await MessageManager.smartEdit(message, `❌ ${error.message}`);
      }
    }

    static async handleSuperUnban(client: TelegramClient, message: Api.Message): Promise<void> {
      try {
        const args = message.message?.split(" ").slice(1) || [];
        const { user, uid, participant, resolutionError } = await UserResolver.resolveTarget(client, message, args);

        if (!uid) {
          await MessageManager.smartEdit(message, "❌ 获取用户失败");
          return;
        }

        if (!participant) {
          const errorText =
            resolutionError === "TARGET_ENTITY_UNRESOLVABLE"
              ? "❌ 无法解析该用户ID（会话未见过且不在任一管理群中）。可先 `.refresh` 后重试，或回复其一则消息"
              : "❌ 获取用户失败";
          await MessageManager.smartEdit(message, errorText);
          return;
        }

        const groups = await GroupManager.getManagedGroups(client);
        const hasBasicGroups = groups.some(group => group.kind === "chat");

        if (groups.length === 0) {
          await MessageManager.smartEdit(message, "❌ 无管理群组");
          return;
        }

        // 和封禁一样先探一遍管理员身份（原版如此），并发走车道，
        // resolveChannelInput 与随后的解封共享缓存。
        const checkQueue = createLaneQueue(CONCURRENCY.LANES, ctx.signal);
        const adminResults = await Promise.allSettled(
          groups.map(group =>
            checkQueue.run(async () => {
              try {
                const target =
                  group.kind === "chat"
                    ? { className: "PeerChat", chatId: bigInt(group.id) }
                    : await resolveChannelInput(client, group);
                return await PermissionManager.isTargetAdmin(client, target, uid);
              } catch {
                return false;
              }
            }),
          ),
        );
        await checkQueue.drain();
        const adminGroups = adminResults.filter(result => result.status === "fulfilled" && result.value).length;

        if (adminGroups > 0 && !args.includes("true")) {
          await MessageManager.smartEdit(
            message,
            `⚠️ 目标在 ${adminGroups} 个管理群中具有管理员身份，请在命令后加上 <code>true</code> 确认执行`,
          );
          return;
        }

        const display = UserResolver.formatUser(user, uid);

        const status = await MessageManager.smartEdit(message, `🔓 在${groups.length}个频道/群组中解封该用户...`, 0);

        const backgroundProcess = async () => {
          const startTime = Date.now();
          const {
            success = 0,
            failed = groups.length,
            unresolved = false,
            unresolvedReason,
          } = await BanManager.batchUnbanUser(client, groups, uid, participant).catch(() => ({
            success: 0,
            failed: groups.length,
            unresolved: true,
            unresolvedReason: "UNKNOWN_ERROR",
          }));

          const elapsed = (Date.now() - startTime) / 1000;

          if (!unresolved && failed > 0) {
            ctx.log.info("aban:operation");
          }

          const failureSummary = unresolved
            ? ` | ⚠️ 目标实体无法解析：${htmlEscape(unresolvedReason || "UNKNOWN_ERROR")}`
            : failed > 0
              ? ` | ⚠️ ${failed} 个频道/群组解封失败`
              : "";
          const capabilityNote = hasBasicGroups ? ` | ℹ️ 基础群不支持跨群解封语义，仅会跳过` : "";
          const result = `✅ 在${success}个频道/群组中解封该用户 ${htmlEscape(display)}${failureSummary}${capabilityNote} | ⏱️${elapsed.toFixed(1)}s`;

          await MessageManager.smartEdit(status, result, 30);
        };

        await backgroundProcess();
      } catch (error: any) {
        await MessageManager.smartEdit(message, `❌ ${error.message}`);
      }
    }
  }

  return {
    UserResolver,
    PermissionManager,
    GroupManager,
    BanManager,
    CommandHandlers,
    MessageManager,
    parseTimeString,
    resetChannelInputCache,
  };
}
