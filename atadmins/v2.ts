import {setTimeout as delay} from "node:timers/promises";
import {definePlugin} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function pages(header: string, mentions: readonly string[]): string[] {
  const result: string[] = [];
  let current = `${header}\n\n`;
  let count = 0;
  for (const value of mentions) {
    if (count >= 25 || `${current}${count ? " · " : ""}${value}`.length > 3500) {
      result.push(current); current = `${header}（续）\n\n${value}`; count = 1;
    } else { current += `${count ? " · " : ""}${value}`; count++; }
  }
  if (count) result.push(current);
  return result;
}

export default function createAtAdmins() {
  return definePlugin({apiVersion: 1, id: "atadmins", description: "在群组中提醒所有管理员",
    commands: {atadmins: {description: "在群组中提醒所有管理员", async handle(invocation, context) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
        await context.telegram.edit(invocation.message, `<b>提醒管理员</b>\n<code>${escape(invocation.prefix)}atadmins [附加消息]</code>`, {parseMode: "html"});
        return;
      }
      try {
        await context.telegram.edit(invocation.message, "正在获取管理员列表…");
        await context.telegram.withClient(async (client, signal) => {
          const {Api} = await import("teleproto");
          const raw = invocation.message.raw as ApiTypes.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          const participants = await client.getParticipants(raw.peerId, {filter: new Api.ChannelParticipantsAdmins()});
          const mentions = participants.flatMap(value => {
            const user = value as ApiTypes.User;
            if (user.bot || user.deleted) return [];
            if (user.username) return [`@${escape(user.username)}`];
            const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "管理员";
            return [`<a href="tg://user?id=${user.id}">${escape(name)}</a>`];
          });
          if (!mentions.length) {
            await context.telegram.edit(invocation.message, "没有找到可提醒的管理员");
            return;
          }
          const header = invocation.args.length ? escape(invocation.args.join(" ")) : "召唤本群管理员";
          const output = pages(header, mentions);
          for (let index = 0; index < output.length; index++) {
            signal.throwIfAborted();
            await client.sendMessage(raw.peerId, {message: output[index]!, parseMode: "html", replyTo: invocation.message.replyToId});
            if (index + 1 < output.length) await delay(800, undefined, {signal});
          }
          if (typeof raw.delete === "function") await raw.delete({revoke: true});
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("atadmins_failed");
        await context.telegram.edit(invocation.message, "<b>提醒管理员失败</b>\n请确认当前会话是可访问管理员列表的群组", {parseMode: "html"});
      }
    }}},
  });
}
