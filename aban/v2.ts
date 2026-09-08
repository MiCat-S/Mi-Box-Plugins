import { definePlugin, type CommandInvocation, type PluginContext } from "telebox/sdk";
import type { Api, TelegramClient } from "teleproto";
import { setTimeout as sleep } from "node:timers/promises";

type Action = "kick" | "ban" | "unban" | "mute" | "unmute";
type Group = { id: string; title: string; kind: "channel" | "chat"; accessHash?: string; deleteMessages?: boolean };
type Target = { id: string; peer: Api.TypeInputPeer; label: string };
const names = { kick: "踢出", ban: "封禁", unban: "解封", mute: "禁言", unmute: "解除禁言",
  sb: "批量封禁", unsb: "批量解封" };
const escape = (value: string) => value.replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const failureLabels: Readonly<Record<string, string>> = {
  USER_NOT_PARTICIPANT: "目标不在该群",
  CHAT_ADMIN_REQUIRED: "管理权限不足",
  USER_ADMIN_INVALID: "无法操作该管理员",
  USER_ID_INVALID: "用户信息无效",
  CHANNEL_PRIVATE: "无法访问该群",
  CHANNEL_INVALID: "群组信息无效",
  PEER_ID_INVALID: "无法解析会话",
  CHAT_WRITE_FORBIDDEN: "会话禁止写入",
  FLOOD_WAIT: "触发频率限制，请稍后重试",
};
const help = (p: string) => `<b>封禁管理</b>
<code>${escape(p)}kick</code> 踢出 · <code>${escape(p)}ban</code> 封禁并清理消息
<code>${escape(p)}unban</code> 解封 · <code>${escape(p)}unmute</code> 解除禁言
<code>${escape(p)}mute [目标] [时长]</code> 禁言，时长如 60s / 5m / 1h / 1d；省略为永久
<code>${escape(p)}sb [目标]</code> 在所有有封禁权限的群/频道封禁，并清理当前群消息
<code>${escape(p)}unsb [目标]</code> 批量解封
<code>${escape(p)}refresh</code> 刷新管理群缓存
目标：回复消息 / @用户名 / 用户ID；管理员目标需追加 <code>true</code>。
基本群仅支持踢出；ban/sb 在基本群执行移出，不会阻止再次加入。`;

class Notice extends Error {}
function errorCode(error: unknown): string {
  const value = error as { errorMessage?: string; message?: string };
  const text = value?.errorMessage ?? value?.message ?? "";
  return ["CHAT_ADMIN_REQUIRED", "USER_ADMIN_INVALID", "USER_NOT_PARTICIPANT", "USER_ID_INVALID",
    "CHANNEL_PRIVATE", "CHANNEL_INVALID", "PEER_ID_INVALID", "CHAT_WRITE_FORBIDDEN"]
    .find(code => text.includes(code)) ?? (/FLOOD_WAIT|wait of \d+ seconds/i.test(text) ? "FLOOD_WAIT" : "请求失败");
}
function parseArgs(invocation: CommandInvocation) {
  const tokens = invocation.args.filter(token => !["true", "false", "confirm"].includes(token.toLowerCase()));
  const confirm = invocation.args.some(token => token.toLowerCase() === "true");
  let duration = 0;
  if (invocation.command === "mute") {
    const last = tokens.at(-1);
    if (last && /^\d+[smhd]$/i.test(last)) {
      const amount = Number(last.slice(0, -1));
      duration = amount * ({ s: 1, m: 60, h: 3600, d: 86400 }[last.slice(-1).toLowerCase()]!);
      // Telegram treats very short/long restrictions as permanent.
      if (!Number.isSafeInteger(duration) || duration < 30 || duration > 366 * 86400) {
        throw new Notice("禁言时长须在 30s 至 366d 之间；永久禁言请省略时长");
      }
      tokens.pop();
    }
  }
  if (tokens.length > 1 || (tokens[0] && !/^(@[a-zA-Z0-9_]+|[1-9]\d*)$/.test(tokens[0]))) {
    throw new Notice("参数无效：使用 @用户名 / 用户ID，或回复目标消息；禁言时长如 5m");
  }
  return { target: tokens[0], confirm, duration };
}

export default function createAban() {
  let cache: { groups: Group[]; expires: number } | undefined;
  const edit = (ctx: PluginContext, inv: CommandInvocation, text: string) =>
    ctx.telegram.edit(inv.message, text, { parseMode: "html", linkPreview: false });

  const execute = async (inv: CommandInvocation, ctx: PluginContext) => {
    const args = inv.command === "refresh" ? undefined : parseArgs(inv);
    await ctx.telegram.withClient(async (client: TelegramClient, signal: AbortSignal) => {
      const { Api } = await import("teleproto");
      const { returnBigInt: integer } = await import("teleproto/Helpers.js");
      const call = async <T>(fn: () => Promise<T>): Promise<T> => {
        signal.throwIfAborted();
        const result = await fn();
        signal.throwIfAborted();
        return result;
      };
      const rpc = async <T>(fn: () => Promise<T>): Promise<T> => {
        try { return await call(fn); }
        catch (error) {
          signal.throwIfAborted();
          const e = error as { seconds?: number; message?: string };
          const seconds = e.seconds ?? Number(e.message?.match(/FLOOD_WAIT_(\d+)/)?.[1]);
          if (errorCode(error) !== "FLOOD_WAIT" || !Number.isFinite(seconds) || seconds < 0 || seconds > 8) throw error;
          await sleep((seconds + 1) * 1000, undefined, { signal });
          return call(fn);
        }
      };
      const fromEntity = (entity: unknown): Group => {
        if (entity instanceof Api.Chat) return { id: entity.id.toString(), title: entity.title, kind: "chat" };
        if (entity instanceof Api.Channel && entity.accessHash !== undefined) {
          return { id: entity.id.toString(), title: entity.title, kind: "channel", accessHash: entity.accessHash.toString(),
          deleteMessages: !!(entity.creator || entity.adminRights?.deleteMessages) };
        }
        throw new Notice("当前会话不是可管理的群组或频道");
      };
      const channel = (g: Group) => new Api.InputChannel({ channelId: integer(g.id), accessHash: integer(g.accessHash!) });
      const groups = async (refresh = false): Promise<Group[]> => {
        if (!refresh && cache && cache.expires > Date.now()) return cache.groups;
        const result = new Map<string, Group>();
        for (const folder of [0, 1]) {
          for await (const dialog of client.iterDialogs({ folder })) {
            signal.throwIfAborted();
            const entity = dialog.entity;
            if (!(entity instanceof Api.Chat || entity instanceof Api.Channel) || entity.left ||
              (entity instanceof Api.Chat && entity.deactivated)) continue;
            if (!entity.creator && !entity.adminRights?.banUsers) continue;
            const g = fromEntity(entity);
            result.set(`${g.kind}:${g.id}`, g);
          }
        }
        signal.throwIfAborted();
        const found = [...result.values()];
        cache = { groups: found, expires: Date.now() + 5 * 60_000 };
        return found;
      };
      if (inv.command === "refresh") {
        cache = undefined;
        const found = await groups(true);
        await edit(ctx, inv, `<b>管理群缓存</b>\n已刷新 <code>${found.length}</code> 个有封禁权限的群组/频道`);
        return;
      }
      const me = await call(() => client.getMe());
      const current = async () => fromEntity(await call(() => client.getEntity(
        (inv.message.raw as { peerId?: Api.TypePeer } | undefined)?.peerId ?? integer(inv.message.chatId))));
      const batch = inv.command === "sb" || inv.command === "unsb";
      const selected = batch ? await groups() : [await current()];
      if (!selected.length) throw new Notice("没有可管理的群组；可先使用 refresh 刷新缓存");

      const resolve = async (): Promise<Target> => {
        let id: string | undefined = args!.target;
        let known: Api.User | undefined;
        if (!id) {
          const reply = await ctx.telegram.getReply(inv.message);
          id = reply?.senderId;
          const sender = (reply?.raw as { sender?: Api.User } | undefined)?.sender;
          if (sender instanceof Api.User && sender.id.toString() === id) known = sender;
        }
        if (!id || !/^(@[a-zA-Z0-9_]+|[1-9]\d*)$/.test(id)) throw new Notice("请回复用户消息，或指定 @用户名 / 正整数用户ID");
        const asTarget = async (user: unknown): Promise<Target> => {
          if (!(user instanceof Api.User)) throw new Notice("目标必须是用户，不能是群组或频道");
          return { id: user.id.toString(), peer: await call(() => client.getInputEntity(user)),
            label: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.id.toString() };
        };
        if (known) return asTarget(known);
        try { return await asTarget(await call(() => client.getEntity(id!.startsWith("@") ? id! : integer(id!)))); }
        catch (error) {
          signal.throwIfAborted();
          if (error instanceof Notice || id.startsWith("@") || errorCode(error) === "FLOOD_WAIT") throw error;
        }
        try {
          const peer = await call(() => client.getInputEntity(integer(id!)));
          if (peer instanceof Api.InputPeerUser && peer.userId.toString() === id) return { id, peer, label: id };
        } catch (error) { signal.throwIfAborted(); if (errorCode(error) === "FLOOD_WAIT") throw error; }
        // Resolve a numeric ID from current/managed chats without caching member lists.
        const sources = [...selected, ...(batch ? [] : await groups())];
        const seen = new Set<string>();
        for (const g of sources) {
          const key = `${g.kind}:${g.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            const result = g.kind === "chat"
              ? await call(() => client.invoke(new Api.messages.GetFullChat({ chatId: integer(g.id) })))
              : await call(() => client.invoke(new Api.channels.GetParticipant({ channel: channel(g),
                participant: new Api.InputPeerUser({ userId: integer(id!), accessHash: integer(0) }) })));
            const user = result.users.find(u => u.id.toString() === id);
            if (user instanceof Api.User) return await asTarget(user);
          } catch (error) {
            signal.throwIfAborted();
            if (!["USER_NOT_PARTICIPANT", "USER_ID_INVALID", "PEER_ID_INVALID", "CHAT_ADMIN_REQUIRED", "CHANNEL_PRIVATE"].includes(errorCode(error))) throw error;
          }
        }
        throw new Notice("无法解析该用户ID；请回复其消息、使用用户名，或 refresh 后重试");
      };
      const target = await resolve();
      if (target.id === me.id.toString()) throw new Notice("不能对当前登录账号执行管理操作");
      const permission = async (g: Group) => {
        if (g.kind === "chat") {
          const full = await call(() => client.invoke(new Api.messages.GetFullChat({ chatId: integer(g.id) })));
          const p = full.fullChat instanceof Api.ChatFull ? full.fullChat.participants : undefined;
          if (!(p instanceof Api.ChatParticipants)) throw new Notice("无法确认基本群管理权限");
          const isAdmin = (id: string) => p.participants.some(item => item.userId.toString() === id &&
            (item instanceof Api.ChatParticipantCreator || item instanceof Api.ChatParticipantAdmin));
          return { allowed: isAdmin(me.id.toString()), admin: isAdmin(target.id), deleteMessages: false };
        }
        // Batch groups already carry the account's creator/banUsers rights from dialogs.
        const self = batch ? undefined : (await call(() => client.invoke(new Api.channels.GetParticipant({
          channel: channel(g), participant: new Api.InputPeerSelf() })))).participant;
        const allowed = batch || self instanceof Api.ChannelParticipantCreator ||
          (self instanceof Api.ChannelParticipantAdmin && !!self.adminRights.banUsers);
        const deleteMessages = batch ? !!g.deleteMessages : self instanceof Api.ChannelParticipantCreator ||
          (self instanceof Api.ChannelParticipantAdmin && !!self.adminRights.deleteMessages);
        if (!allowed) return { allowed, admin: false, deleteMessages };
        let admin = false;
        try {
          const other = (await call(() => client.invoke(new Api.channels.GetParticipant({
            channel: channel(g), participant: target.peer })))).participant;
          admin = other instanceof Api.ChannelParticipantAdmin || other instanceof Api.ChannelParticipantCreator;
        } catch (error) { signal.throwIfAborted(); if (errorCode(error) !== "USER_NOT_PARTICIPANT") throw error; }
        return { allowed, admin, deleteMessages };
      };
      const failures = new Map<string, number>();
      const fail = (reason: string) => failures.set(reason, (failures.get(reason) ?? 0) + 1);
      const ready: { group: Group; deleteMessages: boolean }[] = [];
      let admins = 0, skipped = 0;
      const parallel = async <T>(items: readonly T[], operation: (item: T) => Promise<void>) => {
        let next = 0;
        const settled = await Promise.allSettled(Array.from({length: Math.min(batch ? 4 : 1, items.length)}, async () => {
          while (next < items.length) {
            signal.throwIfAborted();
            await operation(items[next++]);
          }
        }));
        const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason;
      };
      await edit(ctx, inv, `<b>${names[inv.command as keyof typeof names]}</b>\n目标：${escape(target.label.slice(0, 120))}\n正在检查 ${selected.length} 个群/频道…`);
      await parallel(selected, async group => {
        try {
          const rights = await permission(group);
          if (!rights.allowed) { fail("无封禁权限"); return; }
          if (rights.admin) admins++;
          if (group.kind === "chat" && ["unban", "unsb", "mute", "unmute"].includes(inv.command)) { skipped++; return; }
          ready.push({ group, deleteMessages: rights.deleteMessages });
        } catch (error) { signal.throwIfAborted(); fail(error instanceof Notice ? error.message : errorCode(error)); }
      });
      if (admins && !args!.confirm) {
        throw new Notice(`目标在 ${admins} 个群/频道具有管理员身份；请在原命令末尾追加 true 确认`);
      }
      const action: Action = inv.command === "sb" ? "ban" : inv.command === "unsb" ? "unban" : inv.command as Action;
      let success = 0, cleaned = false, historyFailed = false, moved = 0;
      let historyNote = "当前会话不适用";
      const applied = new Set<string>();
      const apply = async (g: Group) => {
        if (g.kind === "chat") {
          const peer = target.peer;
          if (!(peer instanceof Api.InputPeerUser)) throw new Notice("基本群需要可解析的用户实体");
          await rpc(() => client.invoke(new Api.messages.DeleteChatUser({ chatId: integer(g.id),
            userId: new Api.InputUser({ userId: peer.userId, accessHash: peer.accessHash }) })));
          moved++;
          return;
        }
        const set = (rights: Api.ChatBannedRights) => rpc(() => client.invoke(new Api.channels.EditBanned({
          channel: channel(g), participant: target.peer, bannedRights: rights })));
        const restrict = action === "ban" || action === "kick" || action === "mute";
        await set(new Api.ChatBannedRights({ untilDate: action === "mute" && args!.duration
          ? Math.floor(Date.now() / 1000) + args!.duration : 0,
          viewMessages: restrict && action !== "mute", sendMessages: restrict, sendMedia: restrict,
          sendStickers: restrict, sendGifs: restrict, sendGames: restrict, sendInline: restrict, embedLinks: restrict }));
        if (action === "kick") {
          try { await set(new Api.ChatBannedRights({ untilDate: 0 })); }
          catch (error) { signal.throwIfAborted(); throw new Notice("已封禁，但解除失败；需 unban 解封"); }
        }
      };
      await edit(ctx, inv, `<b>${names[inv.command as keyof typeof names]}</b>\n目标：${escape(target.label.slice(0, 120))}\n正在处理 ${ready.length} 个群/频道…`);
      await parallel(ready, async item => {
        try { await apply(item.group); success++; applied.add(`${item.group.kind}:${item.group.id}`); }
        catch (error) { signal.throwIfAborted(); fail(error instanceof Notice ? error.message : errorCode(error)); }
      });
      if (action === "ban" && inv.message.chatId.startsWith("-")) {
        const item = ready.find(({ group: g }) => (g.kind === "channel" ? "-100" + g.id : "-" + g.id) === inv.message.chatId);
        historyNote = !item ? "当前群未通过管理检查" : item.group.kind === "chat" ? "基本群不支持批量清理"
          : !item.deleteMessages ? "缺少删除消息权限" : "当前群封禁未成功";
        if (item?.deleteMessages && item.group.kind === "channel" && applied.has(`channel:${item.group.id}`)) {
          try {
            let result: Api.messages.AffectedHistory;
            do {
              result = await rpc(() => client.invoke(new Api.channels.DeleteParticipantHistory({
                channel: channel(item.group), participant: target.peer })));
            } while (result.offset > 0);
            cleaned = true;
          } catch { signal.throwIfAborted(); historyFailed = true; }
        }
      }
      const failed = [...failures.values()].reduce((a, b) => a + b, 0);
      const reasonEntries = [...failures].sort((a, b) => b[1] - a[1]);
      const reasons = reasonEntries.slice(0, 5)
        .map(([reason, count]) => `${escape(failureLabels[reason] ?? reason)} · ${count} 个`).join("\n");
      const remaining = reasonEntries.slice(5).reduce((total, [, count]) => total + count, 0);
      const counts = [`成功 ${success}`, ...(failed ? [`失败 ${failed}`] : []), ...(skipped ? [`不支持 ${skipped}`] : [])];
      await edit(ctx, inv, `<b>${names[inv.command as keyof typeof names]}结果</b>
<a href="tg://user?id=${target.id}">${escape(target.label.slice(0, 120))}</a> · <code>${target.id}</code>

<b>${counts.join(" · ")}</b>${moved ? `\n基本群移出 ${moved}（不阻止再次加入）` : ""}${action === "mute" ? `\n时长：${args!.duration ? args!.duration + " 秒" : "永久"}` : ""}${action === "ban" ? `\n消息：${cleaned ? "已清理" : historyFailed ? "清理失败" : `未清理（${historyNote}）`}` : ""}${reasons ? `\n\n<b>未完成原因</b>\n${reasons}${remaining ? `\n其他原因 · ${remaining} 个` : ""}` : ""}`);
    });
  };
  const handle = async (inv: CommandInvocation, ctx: PluginContext) => {
    if (inv.command === "aban" || ["help", "h"].includes(inv.args[0] ?? "")) {
      await edit(ctx, inv, help(inv.prefix)); return;
    }
    const run = async () => {
      try {
        if (inv.command === "sb" || inv.command === "unsb") {
          await edit(ctx, inv, `<b>${names[inv.command]}</b>\n正在读取管理群并解析目标…`);
        }
        await execute(inv, ctx);
      }
      catch (error) {
        ctx.signal.throwIfAborted();
        ctx.log.error("aban:command", { command: inv.command, reason: errorCode(error) });
        await edit(ctx, inv, `<b>操作未完成</b>\n${escape(error instanceof Notice ? error.message : errorCode(error))}`);
      }
    };
    if (inv.command === "sb" || inv.command === "unsb") {
      void ctx.tasks.run("aban:batch", run).catch(() => {
        if (!ctx.signal.aborted) ctx.log.error("aban:batch");
      });
    } else await run();
  };
  return definePlugin({ apiVersion: 1, id: "aban", description: help("."),
    commands: Object.fromEntries(Object.entries({ aban: "封禁管理帮助", ...names, refresh: "刷新管理群缓存" })
      .map(([name, description]) => [name, { description, ignoreEdited: true, handle }])),
    cleanup() { cache = undefined; },
  });
}
