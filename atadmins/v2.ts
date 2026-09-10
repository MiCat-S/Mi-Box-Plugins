import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition} from "telebox/sdk";
import {setTimeout as delay} from "node:timers/promises";
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

const atadminsCommand: CommandDefinition = {
  description: "在群组中提醒所有管理员",
  helpArgs: ["help", "h"],
  args: "[附加消息]",
  arguments: [{name: "附加消息", description: "可选；召唤管理员时附带的文字"}],
  examples: [{args: "", description: "使用默认消息召唤管理员"}, {args: "请查看置顶消息"}, {args: "紧急情况需要处理"}],
  help: [
    {
      heading: "功能描述：",
      body: "• 🔔 管理员召唤：一键艾特群组内所有管理员\n" +
        "• 💬 自定义消息：可附带自定义召唤消息\n" +
        "• 📦 智能分片：自动分片避免消息过长\n" +
        "• 🤖 过滤机器人：自动排除机器人和已删除用户",
    },
    {
      heading: "注意事项：",
      body: "• 仅限群组使用，私聊无效\n• 需要获取群组管理员权限\n• 自动删除召唤命令消息\n• 支持回复消息时召唤管理员",
    },
  ],
  async handle(invocation, context) {
    if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
      await context.telegram.edit(invocation.message, renderCommandHelp("atadmins", atadminsCommand, {prefix: invocation.prefix}), {parseMode: "html"});
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
  },
};

export default function createAtAdmins() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "atadmins", description: "在群组中提醒所有管理员",
    renderHelp: prefix => renderCommandHelp("atadmins", atadminsCommand, {prefix, title: "👮 一键 AT 管理员",
      intro: "一键艾特群组内所有管理员，可附带自定义召唤消息。"}),
    commands: {atadmins: atadminsCommand}});
}
