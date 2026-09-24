import { renderHelp } from "./v2/help";
import { definePlugin, ui, type MessageEnvelope, type PluginContext } from "telebox/sdk";
import type { Api as ApiTypes } from "teleproto";

const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[c]!,
  );
const time = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
const pick = (values: readonly string[]) => values[Math.floor(Math.random() * values.length)]!;

function presence(user: ApiTypes.User, Api: typeof import("teleproto").Api) {
  if (user.status instanceof Api.UserStatusOnline) return { label: "在线", days: 0 };
  if (user.status instanceof Api.UserStatusRecently) return { label: "最近上线", days: 0 };
  if (user.status instanceof Api.UserStatusOffline && user.status.wasOnline) {
    const seconds = Number(user.status.wasOnline);
    return { label: time(seconds), days: Math.max(0, Math.floor((Date.now() - seconds * 1000) / 86_400_000)) };
  }
  if (user.status instanceof Api.UserStatusLastWeek) return { label: "一周内", days: 7 };
  if (user.status instanceof Api.UserStatusLastMonth) return { label: "一个月内", days: 30 };
  return { label: "未知", days: null };
}

function icon(user: ApiTypes.User, Api: typeof import("teleproto").Api) {
  if (user.deleted) return "💀";
  if (user.scam || user.fake) return "⚠️";
  if (user.bot) return "🤖";
  if (user.verified) return "✅";
  if (user.premium) return "⭐";
  if (user.status instanceof Api.UserStatusOnline) return "🟢";
  if (user.status instanceof Api.UserStatusRecently) return "🟡";
  if (user.status instanceof Api.UserStatusOffline) return "⚪";
  return "⚫";
}
function attributes(user: ApiTypes.User) {
  const values: string[] = [];
  if (user.verified) values.push("✅ 官方认证");
  if (user.premium) values.push("⭐ Premium");
  if (user.bot) values.push("🤖 机器人");
  if (user.scam) values.push("⚠️ 诈骗账号");
  if (user.fake) values.push("⚠️ 虚假账号");
  if (user.restricted) values.push("🚫 受限账号");
  if (user.deleted) values.push("💀 已销号");
  if (user.support) values.push("🛟 官方客服");
  return values.length ? values : ["普通用户"];
}
function comment(user: ApiTypes.User, days: number | null, lastMessage: Date | null) {
  if (user.deleted)
    return pick([
      "这号已经凉透了 💀",
      "人走茶凉，账号注销",
      "RIP，已销号",
      "曾经来过，如今已去",
      "已成为历史的尘埃...",
      "永别了，朋友",
    ]);
  if (user.bot) return pick(["我是机器人，不需要睡觉 🤖", "24小时待命中~", "机器人永不下线！", "人工智能，永远在线"]);
  const values: string[] = [];
  if (days === null) values.push("神秘人物，行踪成谜 🕵️");
  else if (days === 0)
    values.push(
      pick(["这货还活着！🎉", "活蹦乱跳的呢~", "生龙活虎！", "还在线上浪呢~", "正在摸鱼中...", "还没睡觉呢？"]),
    );
  else if (days <= 1) values.push(pick(["昨天还在呢", "刚刚还活着", "应该还行吧~", "还热乎着呢"]));
  else if (days <= 3) values.push(pick(["这几天有点安静...", "可能去忙别的了", "摸了几天鱼了", "暂时失踪中~"]));
  else if (days <= 7) values.push(pick(["一周没冒泡了", "该不会是触电了？", "是不是去旅游了", "有点危险的信号..."]));
  else if (days <= 30)
    values.push(pick(["这货很久没出现了...", "人呢？？？", "建议去看看急诊", "怕不是注销了吧", "快派人找找！"]));
  else
    values.push(
      pick(["已经凉凉了 💀", "建议报警寻人", "这号估计废了", "默哀三秒钟...", "永远怀念 TA", "化石级选手！"]),
    );
  if (lastMessage) {
    const since = Math.floor((Date.now() - lastMessage.getTime()) / 86_400_000);
    if (since === 0) values.push(pick(["话唠本唠", "刚刚还在唠嗑", "活跃分子！"]));
    else if (since > 3 && since <= 7) values.push("潜水一周了...");
    else if (since <= 30 && since > 7) values.push("本群潜水员认证 🤿");
    else if (since <= 90 && since > 30) values.push("三个月没说话，是不是屏蔽群了？");
    else if (since > 90) values.push("化石级潜水员！上次发言都不知道啥时候了");
  }
  return values.join("\n├ ");
}

async function findInGroups(client: any, id: string, signal: AbortSignal) {
  const dialogs = new Map<string, any>();
  for (const options of [{}, { folderId: 1 }]) {
    signal.throwIfAborted();
    try {
      const found = await client.getDialogs(options);
      signal.throwIfAborted();
      for (const dialog of found ?? []) dialogs.set(String(dialog.id), dialog);
    } catch {
      signal.throwIfAborted();
    }
  }
  for (const dialog of dialogs.values()) {
    signal.throwIfAborted();
    if (!["Chat", "Channel"].includes(dialog.entity?.className)) continue;
    try {
      const participants = await client.getParticipants(dialog.entity, { limit: 200 });
      signal.throwIfAborted();
      for (const participant of participants) {
        signal.throwIfAborted();
        if (String(participant.id) === id) return participant;
      }
    } catch {
      signal.throwIfAborted();
    }
  }
  return null;
}

async function history(client: any, message: MessageEnvelope, user: ApiTypes.User, signal: AbortSignal) {
  const raw = message.raw as { peerId?: unknown } | undefined;
  if (!raw?.peerId) return { label: "无记录", date: null };
  try {
    signal.throwIfAborted();
    const messages = await client.getMessages(raw.peerId, {
      fromUser: user,
      limit: 1,
      ...(message.topicId !== undefined ? { replyTo: message.topicId } : {}),
    });
    signal.throwIfAborted();
    const seconds = Number(messages?.[0]?.date);
    if (!Number.isFinite(seconds) || seconds <= 0) return { label: "无记录", date: null };
    const date = new Date(seconds * 1000);
    return { label: time(seconds), date };
  } catch {
    signal.throwIfAborted();
    return { label: "无记录", date: null };
  }
}

async function deliver(context: PluginContext, message: MessageEnvelope, html: string, signal: AbortSignal) {
  const rendered = await ui.renderRichText(html, ui.PAGE_LABEL_RESERVE + 1);
  signal.throwIfAborted();
  const raw = rendered.length ? rendered : [html],
    pages = raw.map((page, index) => page + ui.pageLabel(index, raw.length)),
    delivery = await ui.deliverPages(pages, signal, async (page, index) => {
      signal.throwIfAborted();
      if (index === 0) await context.telegram.edit(message, page, { parseMode: "html" });
      else await context.telegram.reply(message, page, { parseMode: "html" });
    });
  if (!delivery.interrupted) return;
  if (delivery.published === 0) throw delivery.error;
  context.log.error("isalive_partial_delivery");
  signal.throwIfAborted();
  try {
    await context.telegram.reply(message, ui.interruptedNotice(delivery));
  } catch {
    context.log.error("isalive_delivery_notice_failed");
  }
}

export default function createIsAlive() {
  return definePlugin({
    renderHelp,
    apiVersion: 1,
    id: "isalive",
    description: "查询用户在线状态及本群最后发言",
    commands: {
      isalive: {
        helpArgs: ["help", "h"],
        description: "查询用户在线状态及本群最后发言",
        async handle(invocation, context) {
          const input = invocation.args.join(" ").trim();
          if (!input || ["help", "h"].includes(input.toLowerCase())) {
            await context.telegram.edit(
              invocation.message,
              input ? renderHelp(invocation.prefix) : `Missing parameter.\n\n${renderHelp(invocation.prefix)}`,
              { parseMode: "html" },
            );
            return;
          }
          await context.telegram.edit(invocation.message, "🔍 正在查询中...", { parseMode: "html" });
          try {
            await context.telegram.withClient(async (client, signal) => {
              const teleproto = await import("teleproto");
              signal.throwIfAborted();
              const helpers = await import("teleproto/Helpers.js");
              signal.throwIfAborted();
              const { Api } = teleproto,
                { returnBigInt } = helpers;
              let entity: any;
              if (/^-?\d+$/.test(input)) {
                try {
                  entity = await client.getEntity(returnBigInt(input));
                } catch {
                  signal.throwIfAborted();
                  await context.telegram.edit(invocation.message, "🔍 正在从群组成员中查找用户...", {
                    parseMode: "html",
                  });
                  entity = await findInGroups(client, input, signal);
                }
              } else entity = await client.getEntity(input.startsWith("@") ? input : `@${input}`);
              signal.throwIfAborted();
              if (!(entity instanceof Api.User)) {
                await context.telegram.edit(invocation.message, "❌ 查询失败，提供的用户名或ID可能不存在或有误。", {
                  parseMode: "html",
                });
                return;
              }
              const current = presence(entity, Api),
                record = await history(client, invocation.message, entity, signal),
                name = [entity.firstName, entity.lastName].filter(Boolean).join(" ").trim(),
                attrs = attributes(entity),
                lines = ["<b>👤 用户信息</b>", `${icon(entity, Api)} ${escape(name)}`];
              if (entity.username) lines.push(`├ 用户名: <code>@${escape(entity.username)}</code>`);
              lines.push(
                `└ 用户ID: <a href="tg://user?id=${escape(entity.id)}">${escape(entity.id)}</a>`,
                `<b>📡 在线状态</b>`,
                `├ 状态: <code>${escape(current.label)}</code>`,
                `└ 天数: <code>${current.days === null ? "未知" : `${current.days} 天`}</code>`,
                `<b>💬 发言记录</b>`,
                `└ 本群最后发言: <code>${escape(record.label)}</code>`,
                `<b>🏷️ 账号属性</b>`,
              );
              attrs.forEach((attr, index) => lines.push(`${index === attrs.length - 1 ? "└" : "├"} ${attr}`));
              const note = comment(entity, current.days, record.date);
              if (note) lines.push("", "<b>📝 评语</b>", `└ ${note}`);
              await deliver(context, invocation.message, lines.join("\n"), signal);
            });
          } catch {
            if (context.signal.aborted) return;
            context.log.error("isalive_query_failed");
            await context.telegram.edit(
              invocation.message,
              "❌ 无法解析用户: 查询失败\n\n<i>提示: 使用 UID 查询需要你与该用户有过交互（私聊、同群等）</i>",
              { parseMode: "html" },
            );
          }
        },
      },
    },
  });
}
