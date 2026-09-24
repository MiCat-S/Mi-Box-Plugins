import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, ui, type MessageEnvelope, type PluginContext } from "telebox/sdk";
import {
  buildSortText,
  buildTailText,
  buildTargetDisplay,
  cachedUserDisplay,
  escapeHtml,
  formatAvgPerDay,
  formatDaysAgo,
  userDisplay,
  type Counts,
  type Stat,
  type TargetDisplay,
} from "./v2/render";
import {
  errorText,
  getTextAfterTokens,
  isPotentialUserIdentifier,
  parseSeatActionArgs,
  parseTailArgs,
  parseTrimArgs,
} from "./v2/parse";

type LockData = { schemaVersion: 1; lockedSeats: Record<string, string[]> };
type CacheEntry = { updatedAt: number; avgPerDay?: number; name?: string; username?: string | null };
type CacheData = { schemaVersion: 1; values: Record<string, CacheEntry> };
type Target = { entity: any; title: string; username: string | null; channel: boolean; key: string };

const DAY = 86_400_000,
  WEEK = 604_800;
const locks = (ctx: PluginContext) =>
  ctx.storage.json<LockData>("seat_locks.json", { schemaVersion: 1, lockedSeats: {} });
const cache = (ctx: PluginContext) => ctx.storage.json<CacheData>("avg_cache.json", { schemaVersion: 1, values: {} });
const userName = (user: any) =>
  [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || String(user.id);

async function resolveTarget(ctx: PluginContext, message: MessageEnvelope, value?: string): Promise<Target> {
  return ctx.telegram.withClient(async (client: any, signal) => {
    signal.throwIfAborted();
    const candidate: any = value
      ? /^-?\d+$/.test(value)
        ? BigInt(value)
        : value
      : ((message.raw as any)?.peerId ?? message.chatId);
    const entity: any = await client.getEntity(candidate);
    signal.throwIfAborted();
    if (!entity || !["Chat", "Channel"].includes(entity.className)) throw new Error("目标必须是群组、超级群或频道");
    return {
      entity,
      title: entity.title || "未命名对话",
      username: entity.className === "Channel" && entity.username ? `@${entity.username}` : null,
      channel: entity.className === "Channel",
      key: String(entity.id),
    };
  });
}

async function getAdminCollection(ctx: PluginContext, target: Target): Promise<{ admins: any[]; counts: Counts }> {
  const users = await ctx.telegram.withClient(async (client: any, signal) => {
    const { Api } = await import("teleproto");
    signal.throwIfAborted();
    const list: any[] = target.channel
      ? await client.getParticipants(target.entity, { filter: new Api.ChannelParticipantsAdmins(), showTotal: false })
      : await client.getParticipants(target.entity, { showTotal: false });
    signal.throwIfAborted();
    return list;
  });
  const allAdmins = (users || []).filter(
    (user: any) =>
      user?.className === "User" &&
      (target.channel || ["ChatParticipantAdmin", "ChatParticipantCreator"].includes(user.participant?.className)),
  );
  const visibleAdmins = allAdmins.filter((user: any) => !user.bot);
  return {
    admins: visibleAdmins,
    counts: {
      totalCount: allAdmins.length,
      botCount: allAdmins.filter((user: any) => !!user.bot).length,
      nonBotCount: visibleAdmins.length,
    },
  };
}

async function collectStats(
  ctx: PluginContext,
  message: MessageEnvelope,
  target: Target,
): Promise<{ stats: Stat[]; counts: Counts }> {
  await ctx.telegram.edit(message, `🔍 正在获取 <b>${escapeHtml(target.title)}</b> 的管理员列表...`, {
    parseMode: "html",
    linkPreview: false,
  });
  const { admins, counts } = await getAdminCollection(ctx, target);
  if (counts.nonBotCount === 0) throw new Error("当前对话没有可统计的非 Bot 管理员，或无法获取管理员列表");
  const lockSet = new Set((await locks(ctx).read()).lockedSeats[target.key] || []);
  const saved = await cache(ctx).read();

  const stats = await ctx.telegram.withClient(async (client: any, signal) => {
    const { Api } = await import("teleproto");
    const result: Stat[] = [];
    for (let index = 0; index < admins.length; index++) {
      ctx.signal.throwIfAborted();
      if (index === 0 || (index + 1) % 5 === 0 || index === admins.length - 1) {
        await ctx.telegram.edit(
          message,
          `📊 正在统计管理员排序简表...\n目标: <b>${escapeHtml(target.title)}</b>\n进度: <code>${index + 1}/${admins.length}</code>`,
          { parseMode: "html", linkPreview: false },
        );
        signal.throwIfAborted();
      }
      const user: any = admins[index];
      const id = String(user.id);
      const key = `${target.key}:${id}`;
      const hit = saved.values[key];
      let avg = typeof hit?.avgPerDay === "number" && Date.now() - hit.updatedAt < DAY ? hit.avgPerDay : -1;
      if (avg < 0) {
        try {
          const from = await client.getInputEntity(user);
          signal.throwIfAborted();
          const found: any = await client.invoke(
            new Api.messages.Search({
              peer: target.entity,
              q: "",
              filter: new Api.InputMessagesFilterEmpty(),
              minDate: Math.floor(Date.now() / 1000) - WEEK,
              offsetId: 0,
              addOffset: 0,
              limit: 1,
              maxId: 0,
              minId: 0,
              hash: 0 as any,
              fromId: from,
            }),
          );
          signal.throwIfAborted();
          avg = Number(found.count ?? found.messages?.length ?? 0) / 7;
        } catch (error) {
          if (signal.aborted || ctx.signal.aborted) throw error;
        }
      }
      signal.throwIfAborted();
      let last = 0;
      try {
        const found: any[] = await client.getMessages(target.entity, { fromUser: user, limit: 1 });
        signal.throwIfAborted();
        last = Number(found[0]?.date || 0) * 1000;
      } catch (error) {
        if (signal.aborted || ctx.signal.aborted) throw error;
      }
      signal.throwIfAborted();
      const participant = user.participant;
      result.push({
        user,
        id,
        name: userName(user),
        username: user.username ? String(user.username) : null,
        rank: participant?.rank?.trim() || "无",
        avg,
        avgText: avg < 0 ? "N/A" : formatAvgPerDay(avg),
        last,
        lastText: last ? formatDaysAgo(new Date(last)) : "无记录",
        locked: lockSet.has(id),
        creator: ["ChatParticipantCreator", "ChannelParticipantCreator"].includes(participant?.className),
      });
      await cache(ctx).update(data => ({
        ...data,
        values: {
          ...data.values,
          [key]: {
            updatedAt: Date.now(),
            ...(avg >= 0 ? { avgPerDay: avg } : {}),
            name: userName(user),
            username: user.username || null,
          },
        },
      }));
    }
    return result.sort((a, b) => b.avg - a.avg || b.last - a.last || a.name.localeCompare(b.name, "zh-CN"));
  });
  return { stats, counts };
}

async function resolveUserForSeatAction(
  ctx: PluginContext,
  target: Target,
  identifier: string,
): Promise<any | undefined> {
  const trimmed = identifier.trim();
  if (!trimmed || !isPotentialUserIdentifier(trimmed)) return undefined;
  const isNumeric = /^-?\d+$/.test(trimmed);
  const exact = isNumeric ? BigInt(trimmed).toString() : "";
  return ctx.telegram.withClient(async (client: any, signal) => {
    signal.throwIfAborted();
    try {
      const entity: any = await client.getEntity(isNumeric ? BigInt(trimmed) : trimmed);
      signal.throwIfAborted();
      if (entity?.className === "User") return entity;
    } catch (error) {
      if (signal.aborted) throw error;
    }
    return target.channel
      ? await findUserInChannelParticipants(client, target, trimmed, exact, signal)
      : await findUserInChatParticipants(client, target, trimmed, exact, signal);
  });
}

async function findUserInChatParticipants(
  client: any,
  target: Target,
  identifier: string,
  exact: string,
  signal: AbortSignal,
): Promise<any | undefined> {
  const username = /^-?\d+$/.test(identifier) ? "" : identifier.replace(/^@/, "").toLowerCase();
  signal.throwIfAborted();
  const participants: any[] = await client.getParticipants(target.entity, {
    showTotal: false,
    ...(username ? { search: username } : {}),
  });
  signal.throwIfAborted();
  return participants.find(
    (user: any) =>
      user?.className === "User" &&
      (username ? (user.username || "").toLowerCase() === username : String(user.id) === exact),
  );
}

async function findUserInChannelParticipants(
  client: any,
  target: Target,
  identifier: string,
  exact: string,
  signal: AbortSignal,
): Promise<any | undefined> {
  const username = /^-?\d+$/.test(identifier) ? "" : identifier.replace(/^@/, "").toLowerCase();
  if (username) {
    try {
      signal.throwIfAborted();
      const users: any[] = await client.getParticipants(target.entity, { search: username, showTotal: false });
      signal.throwIfAborted();
      const matched = users.find(
        (user: any) => user?.className === "User" && (user.username || "").toLowerCase() === username,
      );
      if (matched) return matched;
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  if (!exact) return undefined;
  signal.throwIfAborted();
  const inputChannel = await client.getInputEntity(target.entity);
  signal.throwIfAborted();
  const { Api } = await import("teleproto");
  signal.throwIfAborted();
  let offset = 0;
  const limit = 200;
  for (let index = 0; index < 5; index++) {
    const result: any = await client.invoke(
      new Api.channels.GetParticipants({
        channel: inputChannel,
        filter: new Api.ChannelParticipantsRecent(),
        offset,
        limit,
        hash: 0 as any,
      }),
    );
    signal.throwIfAborted();
    const users: any[] = (result?.users || []).filter((user: any) => user?.className === "User");
    const matched = users.find((user: any) => String(user.id) === exact);
    if (matched) return matched;
    const participants: any[] = result?.participants || [];
    if (!participants.length) break;
    offset += participants.length;
  }
  return undefined;
}

async function demote(ctx: PluginContext, target: Target, user: any): Promise<void> {
  await ctx.telegram.withClient(async (client: any, signal) => {
    const { Api } = await import("teleproto");
    signal.throwIfAborted();
    const inputUser = await client.getInputEntity(user);
    signal.throwIfAborted();
    if (target.channel) {
      const inputChannel = await client.getInputEntity(target.entity);
      signal.throwIfAborted();
      await client.invoke(
        new Api.channels.EditAdmin({
          channel: inputChannel,
          userId: inputUser,
          adminRights: new Api.ChatAdminRights({}),
          rank: "",
        }),
      );
    } else {
      await client.invoke(
        new Api.messages.EditChatAdmin({ chatId: target.entity.id, userId: inputUser, isAdmin: false }),
      );
    }
    signal.throwIfAborted();
  });
}

async function getCachedUserInfo(
  ctx: PluginContext,
  target: Target,
  userId: string,
): Promise<{ name?: string; username?: string | null } | undefined> {
  const entry = (await cache(ctx).read()).values[`${target.key}:${userId}`];
  if (!entry || Date.now() - entry.updatedAt > DAY) return undefined;
  if (!entry.name && !entry.username) return undefined;
  return { name: entry.name, username: entry.username };
}

async function handleSeatAction(
  ctx: PluginContext,
  message: MessageEnvelope,
  action: "lock" | "unlock",
  rawText: string,
  commandName: string,
): Promise<void> {
  const remainder = getTextAfterTokens(rawText, 2);
  const { identifiers, targetArg } = parseSeatActionArgs(remainder);
  if (identifiers.length === 0) {
    await ctx.telegram.edit(
      message,
      `❌ 参数不足\n\n用法:\n<code>${escapeHtml(commandName)} ${action} 用户1,用户2 [对话id/@username]</code>`,
      { parseMode: "html", linkPreview: false },
    );
    return;
  }
  const target = await resolveTarget(ctx, message, targetArg);
  await ctx.telegram.edit(
    message,
    `🔍 正在解析要${action === "lock" ? "锁定" : "取消锁定"}席位的用户...\n${buildTargetDisplay(target)}`,
    { parseMode: "html", linkPreview: false },
  );

  const resolvedUsers = new Map<string, any>();
  const rawResolvedIds = new Set<string>();
  const failures: string[] = [];
  for (const identifier of identifiers) {
    ctx.signal.throwIfAborted();
    try {
      const user = await resolveUserForSeatAction(ctx, target, identifier);
      if (!user) {
        if (/^-?\d+$/.test(identifier.trim())) rawResolvedIds.add(BigInt(identifier.trim()).toString());
        else failures.push(`${identifier}（未找到用户）`);
        continue;
      }
      resolvedUsers.set(String(user.id), user);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      if (/^-?\d+$/.test(identifier.trim())) rawResolvedIds.add(BigInt(identifier.trim()).toString());
      else failures.push(`${identifier}（${errorText(error)}）`);
    }
  }

  const resolvedList = Array.from(resolvedUsers.values());
  const storedUserIds = Array.from(new Set([...resolvedList.map(user => String(user.id)), ...rawResolvedIds]));
  if (storedUserIds.length > 0) {
    await locks(ctx).update(data => {
      const set = new Set(data.lockedSeats[target.key] || []);
      for (const id of storedUserIds) action === "lock" ? set.add(id) : set.delete(id);
      const lockedSeats = { ...data.lockedSeats };
      if (set.size) lockedSeats[target.key] = Array.from(set).sort((a, b) => a.localeCompare(b, "zh-CN"));
      else delete lockedSeats[target.key];
      return { ...data, schemaVersion: 1, lockedSeats };
    });
  }

  const lines = [
    `${action === "lock" ? "🔒" : "🔓"} <b>席位${action === "lock" ? "锁定" : "取消锁定"}完成</b>`,
    buildTargetDisplay(target),
    `成功: <code>${storedUserIds.length}</code>`,
    `失败: <code>${failures.length}</code>`,
  ];
  if (storedUserIds.length > 0) {
    lines.push("", "<b>成功用户</b>");
    for (const user of resolvedList) lines.push(`• ${userDisplay(user)}`);
    for (const userId of rawResolvedIds) {
      if (!resolvedUsers.has(userId)) {
        const cachedUser = await getCachedUserInfo(ctx, target, userId);
        lines.push(`• ${cachedUserDisplay(userId, cachedUser)} <code>（按 ID 直接记录）</code>`);
      }
    }
  }
  if (failures.length > 0) {
    lines.push("", "<b>失败项</b>");
    failures.forEach(failure => lines.push(`• ${escapeHtml(failure)}`));
  }
  await send(ctx, message, lines.join("\n"));
}

async function handleClear(ctx: PluginContext, message: MessageEnvelope, rawText: string): Promise<void> {
  const targetArg = getTextAfterTokens(rawText, 2) || undefined;
  const target = await resolveTarget(ctx, message, targetArg);
  await ctx.telegram.edit(message, `🧹 正在清理周日均缓存...\n${buildTargetDisplay(target)}`, {
    parseMode: "html",
    linkPreview: false,
  });
  const prefixKey = `${target.key}:`;
  const before = await cache(ctx).read();
  const count = Object.keys(before.values).filter(key => key.startsWith(prefixKey)).length;
  await cache(ctx).update(data => ({
    ...data,
    values: Object.fromEntries(Object.entries(data.values).filter(([key]) => !key.startsWith(prefixKey))),
  }));
  await ctx.telegram.edit(
    message,
    [
      `🧹 <b>缓存已清理</b>`,
      buildTargetDisplay(target),
      `清理条目: <code>${count}</code>`,
      `说明: <code>已清理周日均和用户信息缓存，席位锁定数据不受影响</code>`,
    ].join("\n"),
    { parseMode: "html", linkPreview: false },
  );
}

async function handleTrimAction(
  ctx: PluginContext,
  message: MessageEnvelope,
  rawText: string,
  commandName: string,
): Promise<void> {
  const remainder = getTextAfterTokens(rawText, 2);
  const { limit, targetArg } = parseTrimArgs(remainder);
  if (!limit) {
    await ctx.telegram.edit(
      message,
      `❌ 参数不足\n\n<code>rm</code> 的人数参数是必填正整数。\n\n用法:\n<code>${escapeHtml(commandName)} rm 正整数 [对话id/@username]</code>`,
      { parseMode: "html", linkPreview: false },
    );
    return;
  }
  const target = await resolveTarget(ctx, message, targetArg);
  const { stats } = await collectStats(ctx, message, target);
  const candidates = stats.filter(stat => !stat.locked && !stat.creator);
  const selected = candidates.slice(-limit).reverse();

  if (selected.length === 0) {
    await ctx.telegram.edit(
      message,
      [`✂️ <b>无需处理</b>`, buildTargetDisplay(target), `说明: <code>没有可下掉的未锁定席位管理员</code>`].join("\n"),
      { parseMode: "html", linkPreview: false },
    );
    return;
  }

  const success: Stat[] = [];
  const failures: string[] = [];
  for (let index = 0; index < selected.length; index++) {
    ctx.signal.throwIfAborted();
    const stat = selected[index];
    await ctx.telegram.edit(
      message,
      `✂️ 正在下掉倒数管理员...\n${buildTargetDisplay(target)}\n进度: <code>${index + 1}/${selected.length}</code>`,
      { parseMode: "html", linkPreview: false },
    );
    try {
      await demote(ctx, target, stat.user);
      success.push(stat);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      failures.push(`• ${userDisplay(stat.user)}（${escapeHtml(errorText(error))}）`);
    }
  }

  const lines = [
    `✂️ <b>尾部管理员清理完成</b>`,
    buildTargetDisplay(target),
    `目标人数: <code>${limit}</code>`,
    `实际候选: <code>${selected.length}</code>`,
    `成功: <code>${success.length}</code>`,
    `失败: <code>${failures.length}</code>`,
  ];
  if (success.length > 0) {
    lines.push("", "<b>已下掉</b>");
    for (const stat of success) lines.push(`• ${userDisplay(stat.user)} | <code>${escapeHtml(stat.avgText)}</code>`);
  }
  if (failures.length > 0) {
    lines.push("", "<b>失败项</b>");
    lines.push(...failures);
  }
  await send(ctx, message, lines.join("\n"));
}

async function handleList(ctx: PluginContext, message: MessageEnvelope, rawText: string): Promise<void> {
  const targetArg = getTextAfterTokens(rawText, 2) || undefined;
  const target = await resolveTarget(ctx, message, targetArg);
  const { stats, counts } = await collectStats(ctx, message, target);
  await send(ctx, message, buildSortText(target, stats, counts));
}

async function handleTail(ctx: PluginContext, message: MessageEnvelope, rawText: string): Promise<void> {
  const remainder = getTextAfterTokens(rawText, 2);
  const firstToken = remainder.trim().split(/\s+/).filter(Boolean)[0] || "";
  if (firstToken && /^\d+$/.test(firstToken) && !/^[1-9]\d*$/.test(firstToken)) {
    await ctx.telegram.edit(message, `❌ 参数错误\n\n<code>tail</code> 的人数参数必须是正整数`, {
      parseMode: "html",
      linkPreview: false,
    });
    return;
  }
  const { limit, targetArg } = parseTailArgs(remainder);
  const target = await resolveTarget(ctx, message, targetArg);
  const { stats, counts } = await collectStats(ctx, message, target);
  await send(ctx, message, buildTailText(target, stats, counts, limit));
}

async function send(ctx: PluginContext, message: MessageEnvelope, text: string): Promise<void> {
  // SDK pagination keeps HTML/entities intact and every page non-empty and bounded.
  const pages = await ui.renderRichText(text, ui.PAGE_LABEL_RESERVE + 48);
  const usable = pages.length ? pages : [text];
  await ctx.telegram.edit(message, usable[0], { parseMode: "html", linkPreview: false });
  for (let index = 1; index < usable.length; index++) {
    await ctx.telegram.reply(message, `📋 <b>续 ${index}/${usable.length - 1}</b>\n\n${usable[index]}`, {
      parseMode: "html",
      linkPreview: false,
    });
  }
}

export default function createAdminBoard(): ReturnType<typeof definePlugin> {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "admin_board",
    description: "管理员活跃度排行、席位锁定和尾部管理员清理",
    commands: {
      admin_board: {
        helpArgs: ["help", "h"],
        helpOnEmpty: true,
        description: "管理员席位管理",
        async handle(invocation, ctx) {
          const message = invocation.message;
          const rawText = (message.text || "").trim();
          const action = (invocation.args[0] || "").toLowerCase();
          const commandName = `${invocation.prefix}admin_board`;
          try {
            if (!action || action === "help" || action === "h") {
              await ctx.telegram.edit(message, renderPluginHelp(invocation.prefix), {
                parseMode: "html",
                linkPreview: false,
              });
              return;
            }
            if (action === "ls") {
              await handleList(ctx, message, rawText);
              return;
            }
            if (action === "tail") {
              await handleTail(ctx, message, rawText);
              return;
            }
            if (action === "rm") {
              await handleTrimAction(ctx, message, rawText, commandName);
              return;
            }
            if (action === "lock" || action === "unlock") {
              await handleSeatAction(ctx, message, action, rawText, commandName);
              return;
            }
            if (action === "clear") {
              await handleClear(ctx, message, rawText);
              return;
            }
            await ctx.telegram.edit(
              message,
              `❌ 不支持的动作: <code>${escapeHtml(action)}</code>\n\n${renderPluginHelp(invocation.prefix)}`,
              { parseMode: "html", linkPreview: false },
            );
          } catch (error) {
            if (!ctx.signal.aborted)
              await ctx.telegram.edit(message, `❌ <b>执行失败</b>\n\n${escapeHtml(errorText(error))}`, {
                parseMode: "html",
                linkPreview: false,
              });
          }
        },
      },
    },
  });
}
