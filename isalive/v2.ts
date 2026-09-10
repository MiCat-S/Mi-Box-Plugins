import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);
const time = (value: number): string => new Date(value * 1000).toLocaleString("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

function status(user: ApiTypes.User, Api: typeof import("teleproto").Api): {label: string; days?: number} {
  if (user.status instanceof Api.UserStatusOnline) return {label: "在线", days: 0};
  if (user.status instanceof Api.UserStatusRecently) return {label: "最近上线", days: 0};
  if (user.status instanceof Api.UserStatusOffline && user.status.wasOnline) {
    return {label: time(Number(user.status.wasOnline)), days: Math.max(0, Math.floor((Date.now() - Number(user.status.wasOnline) * 1000) / 86400000))};
  }
  if (user.status instanceof Api.UserStatusLastWeek) return {label: "一周内", days: 7};
  if (user.status instanceof Api.UserStatusLastMonth) return {label: "一个月内", days: 30};
  return {label: "未知"};
}

function attributes(user: ApiTypes.User): string[] {
  const values: string[] = [];
  if (user.verified) values.push("官方认证");
  if (user.premium) values.push("Premium");
  if (user.bot) values.push("机器人");
  if (user.scam) values.push("诈骗标记");
  if (user.fake) values.push("虚假账号");
  if (user.restricted) values.push("受限账号");
  if (user.deleted) values.push("已注销");
  return values.length ? values : ["普通用户"];
}

const isaliveCommand: CommandDefinition = {
  description: "查询用户在线状态及本群最后发言",
  helpArgs: ["help", "h"],
  args: "用户名或 UID",
  arguments: [{name: "用户名或 UID", description: "用户名（可带或不带 @）或用户 ID；留空显示帮助"}],
  examples: [{args: "@username"}, {args: "123456789"}],
  help: [
    {heading: "说明：", body: "查询用户在线状态、账号属性以及该用户在当前群组的最后发言时间；使用 UID 时需要账号曾与该用户交互。"},
    {heading: "定时查询：", body: "可配合 acron 每天定时查询；将群 ID 与用户名替换为目标：<pre>{prefix}acron cmd 0 0 12 * * * &lt;群ID&gt; 每日状态查询\n{prefix}isalive @username</pre>"},
  ],
  async handle(invocation, context) {
      const input = invocation.args.join(" ").trim();
      if (!input || ["help", "h"].includes(input.toLowerCase())) {
        await context.telegram.edit(invocation.message, renderCommandHelp("isalive", isaliveCommand, {prefix: invocation.prefix, title: "🫀 用户状态查询"}), {parseMode: "html"});
        return;
      }
      try {
        await context.telegram.edit(invocation.message, "正在查询用户状态…");
        await context.telegram.withClient(async (client, signal) => {
          const {Api} = await import("teleproto");
          const {returnBigInt} = await import("teleproto/Helpers.js");
          const target = /^-?\d+$/.test(input) ? returnBigInt(input) : input.startsWith("@") ? input : `@${input}`;
          const entity = await client.getEntity(target);
          signal.throwIfAborted();
          if (!(entity instanceof Api.User)) throw new Error("Not a user");
          const current = status(entity, Api);
          let lastMessage = "无记录";
          const raw = invocation.message.raw as ApiTypes.Message | undefined;
          if (raw?.peerId) {
            try {
              const messages = await client.getMessages(raw.peerId, {fromUser: entity, limit: 1});
              const date = (messages[0] as ApiTypes.Message | undefined)?.date;
              if (date) lastMessage = time(Number(date));
            } catch { context.log.error("isalive_history_failed"); }
          }
          const name = `${entity.firstName ?? ""} ${entity.lastName ?? ""}`.trim() || entity.username || String(entity.id);
          const lines = [
            "<b>用户状态</b>",
            `用户：<a href="tg://user?id=${escape(entity.id)}">${escape(name)}</a>`,
            entity.username ? `用户名：<code>@${escape(entity.username)}</code>` : "",
            `UID：<code>${escape(entity.id)}</code>`,
            `在线状态：<code>${escape(current.label)}</code>`,
            current.days === undefined ? "" : `离线天数：<code>${current.days} 天</code>`,
            `本群最后发言：<code>${escape(lastMessage)}</code>`,
            `账号属性：${attributes(entity).map(escape).join(" · ")}`,
          ].filter(Boolean);
          await context.telegram.edit(invocation.message, lines.join("\n"), {parseMode: "html"});
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("isalive_query_failed");
        await context.telegram.edit(invocation.message, "无法解析该用户；使用 UID 时需要曾与该用户交互");
      }
    },
};
export default function createIsAlive() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "isalive", description: "查询用户在线状态及本群最后发言",
    renderHelp: prefix => renderCommandHelp("isalive", isaliveCommand, {prefix, title: "🫀 用户状态查询"}),
    commands: {isalive: isaliveCommand},
  });
}
