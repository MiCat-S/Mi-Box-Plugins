import { renderHelp as renderPluginHelp } from "./v2/help";
import { setTimeout as delay } from "node:timers/promises";
import { STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition } from "telebox/sdk";
import type { Api as ApiTypes } from "teleproto";

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>\"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );

function pages(header: string, mentions: readonly string[]): string[] {
  const result: string[] = [];
  let current = header;
  let count = 0;
  for (const mention of mentions) {
    const addition = `${count ? " , " : ""}${mention}`;
    if (count >= 25 || current.length + addition.length > 3500) {
      result.push(current);
      current = header + mention;
      count = 1;
    } else {
      current += addition;
      count += 1;
    }
  }
  if (count) result.push(current);
  return result;
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  let detail: string;
  if (message.includes("CHAT_ADMIN_REQUIRED")) {
    detail = "💡 <b>原因:</b> 机器人需要管理员权限才能获取管理员列表";
  } else if (message.includes("CHANNEL_PRIVATE")) {
    detail = "💡 <b>原因:</b> 无法访问此群组的管理员信息";
  } else if (message.includes("FLOOD_WAIT")) {
    const waitTime = message.match(/\d+/)?.[0] ?? "60";
    detail = `💡 <b>原因:</b> 请求过于频繁，请等待 ${waitTime} 秒后重试`;
  } else {
    detail = "💡 <b>原因:</b> 暂时无法获取管理员列表，请稍后重试";
  }
  return `❌ <b>获取管理员列表失败</b>\n\n${detail}`;
}

const atadminsCommand: CommandDefinition = {
  description: "在群组中提醒所有管理员",
  helpArgs: ["help", "h"],
  args: "[附加消息]",
  arguments: [{ name: "附加消息", description: "可选；召唤管理员时附带的文字" }],
  examples: [
    { args: "", description: "使用默认消息召唤管理员" },
    { args: "请查看置顶消息", description: "附带自定义消息召唤" },
    { args: "紧急情况需要处理", description: "紧急召唤" },
  ],
  help: [
    {
      heading: "功能描述：",
      body:
        "• 🔔 管理员召唤：一键艾特群组内所有管理员\n" +
        "• 💬 自定义消息：可附带自定义召唤消息\n" +
        "• 📦 智能分片：自动分片避免消息过长\n" +
        "• 🤖 过滤机器人：自动排除机器人和已删除用户",
    },
    {
      heading: "注意事项：",
      body:
        "• 仅限群组使用，私聊无效\n" +
        "• 需要获取群组管理员权限\n" +
        "• 自动删除召唤命令消息\n" +
        "• 支持回复消息时召唤管理员",
    },
  ],
  async handle(invocation, context) {
    if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
      await context.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), { parseMode: "html" });
      return;
    }

    try {
      const { Api } = await import("teleproto");
      const raw = invocation.message.raw as ApiTypes.Message | undefined;
      if (!raw?.peerId) throw new Error("Missing peer");
      if (invocation.message.chatType === "private" || raw.peerId instanceof Api.PeerUser) {
        await context.telegram.edit(
          invocation.message,
          `❌ <b>此命令只能在群组中使用</b>\n\n💡 请在群组中使用 <code>${escape(invocation.prefix)}atadmins</code> 命令`,
          { parseMode: "html" },
        );
        return;
      }

      await context.telegram.edit(invocation.message, "正在获取管理员列表…");
      await context.telegram.withClient(async (client, signal) => {
        const participants = await client.getParticipants(raw.peerId, { filter: new Api.ChannelParticipantsAdmins() });
        const mentions: string[] = [];
        let adminCount = 0;
        let botCount = 0;
        for (const value of participants) {
          const user = value as ApiTypes.User;
          if (user.deleted) continue;
          if (user.bot) {
            botCount += 1;
            continue;
          }
          adminCount += 1;
          if (user.username) {
            mentions.push(`@${escape(user.username)}`);
          } else {
            const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "用户";
            mentions.push(`<a href="tg://user?id=${user.id}">${escape(name)}</a>`);
          }
        }

        if (!mentions.length) {
          await context.telegram.edit(
            invocation.message,
            `❌ <b>未找到可召唤的管理员</b>\n\n📊 统计信息:\n• 总管理员: ${adminCount}\n• 机器人管理员: ${botCount}\n• 可召唤: 0\n\n💡 可能原因：所有管理员都是机器人或已删除账户`,
            { parseMode: "html" },
          );
          return;
        }

        const customMessage = invocation.args.join(" ").trim();
        const header = `${customMessage ? escape(customMessage) : "召唤本群所有管理员"}：\n\n`;
        const output = pages(header, mentions);
        for (let index = 0; index < output.length; index += 1) {
          signal.throwIfAborted();
          await client.sendMessage(raw.peerId, {
            message: output[index]!,
            parseMode: "html",
            replyTo: invocation.message.replyToId,
            topMsgId: invocation.message.topicId,
          });
          if (index + 1 < output.length) await delay(800, undefined, { signal });
        }

        if (typeof raw.delete === "function") {
          await delay(3000, undefined, { signal });
          signal.throwIfAborted();
          try {
            await raw.delete({ revoke: true });
          } catch {
            if (!signal.aborted) context.log.info("atadmins_receipt_cleanup_failed");
          }
        }
      });
    } catch (error) {
      if (context.signal.aborted) return;
      context.log.error("atadmins_failed");
      await context.telegram.edit(invocation.message, failureMessage(error), { parseMode: "html" });
    }
  },
};

export default function createAtAdmins() {
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "atadmins",
    description: "在群组中提醒所有管理员",
    renderHelp: renderPluginHelp,
    commands: { atadmins: atadminsCommand },
  });
}
