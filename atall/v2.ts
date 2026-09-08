import {renderHelp as renderPluginHelp} from "./v2/help";
import {setTimeout as delay} from "node:timers/promises";
import {definePlugin} from "telebox/sdk";
import type {Api} from "teleproto";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function mention(user: Api.User): string | undefined {
  if (user.bot || user.deleted) return undefined;
  if (user.username) return `@${escape(user.username)}`;
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return name ? `<a href="tg://user?id=${user.id}">${escape(name)}</a>` : undefined;
}

function pages(values: readonly string[]): string[] {
  const result: string[] = [];
  let current = "<b>@所有人</b>\n";
  for (const value of values) {
    const next = `${current}${current.endsWith("\n") ? "" : " "}${value}`;
    if (next.length > 3900) result.push(current), current = `<b>@所有人（续）</b>\n${value}`;
    else current = next;
  }
  if (current.trim() !== "<b>@所有人</b>") result.push(current);
  return result;
}

export default function createAtAll() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "atall", description: "在群组中提醒所有可见成员",
    commands: {atall: {helpArgs: ["help","h"], description: "在群组中提醒所有可见成员", async handle(invocation, context) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
        await context.telegram.edit(invocation.message, `<b>提醒所有成员</b>\n<code>${escape(invocation.prefix)}atall</code>\n大量提醒可能触发 Telegram 频率限制。`, {parseMode: "html"});
        return;
      }
      try {
        await context.telegram.edit(invocation.message, "正在获取群组成员…");
        await context.telegram.withClient(async (client, signal) => {
          const raw = invocation.message.raw as Api.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          const users = await client.getParticipants(raw.peerId, {});
          const mentions = users.map(user => mention(user as Api.User)).filter((value): value is string => Boolean(value));
          if (!mentions.length) {
            await context.telegram.edit(invocation.message, "没有找到可提醒的成员");
            return;
          }
          const output = pages(mentions);
          for (let index = 0; index < output.length; index++) {
            signal.throwIfAborted();
            await client.sendMessage(raw.peerId, {message: output[index]!, parseMode: "html", replyTo: index === 0 ? invocation.message.id : undefined});
            if (index + 1 < output.length) await delay(500, undefined, {signal});
          }
          if (typeof raw.delete === "function") await raw.delete({revoke: true});
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("atall_failed");
        await context.telegram.edit(invocation.message, "<b>提醒失败</b>\n请确认当前会话是可访问成员列表的群组", {parseMode: "html"});
      }
    }}},
  });
}
