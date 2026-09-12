import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function duration(value: string | undefined): number | undefined {
  const match = /^(\d+)([smhd])?$/i.exec(value ?? "");
  if (!match) return undefined;
  const seconds = Number(match[1]) * ({s: 1, m: 60, h: 3600, d: 86400}[match[2]?.toLowerCase() ?? "s"] ?? 1);
  return Number.isSafeInteger(seconds) && seconds >= 60 && seconds <= 366 * 86400 ? seconds : undefined;
}

export default function createPortball() {
  const command: CommandDefinition = {"args":"[理由] 时间","arguments":[{"name":"时间","required":true,"description":"放在末尾，支持 s（默认秒）、m、h、d，范围 60 秒至 366 天"}],"examples":[{"args":"广告 5m"},{"args":"10m"},{"args":"刷屏 1h"},{"args":"300"}],"help":[{"heading":"条件：","body":"回复目标用户的消息；需要管理员权限及可用的群组成员限制接口。不能对自己操作，到期自动解除。"}],description: "回复消息临时禁言群组成员", async handle(invocation, context) {
      const seconds = duration(invocation.args.at(-1));
      if (!seconds || invocation.message.replyToId === undefined) {
        await context.telegram.edit(invocation.message,
          help(invocation.prefix),
          {parseMode: "html"});
        return;
      }
      const reason = invocation.args.slice(0, -1).join(" ").trim();
      try {
        const reply = await context.telegram.getReply(invocation.message);
        if (!reply?.senderId) throw new Error("Missing sender");
        await context.telegram.withClient(async (client, signal) => {
          const {Api} = await import("teleproto");
          const {returnBigInt} = await import("teleproto/Helpers.js");
          const raw = invocation.message.raw as ApiTypes.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          const [chat, target, me] = await Promise.all([
            client.getEntity(raw.peerId), client.getEntity(returnBigInt(reply.senderId!)), client.getMe(),
          ]);
          signal.throwIfAborted();
          if (!(chat instanceof Api.Channel)) throw new Error("Unsupported chat");
          if (String((target as ApiTypes.User).id) === String(me.id)) throw new Error("Self target");
          const self = await client.invoke(new Api.channels.GetParticipant({
            channel: chat, participant: new Api.InputPeerSelf(),
          }));
          if (!(self.participant instanceof Api.ChannelParticipantCreator) &&
              (!(self.participant instanceof Api.ChannelParticipantAdmin) || !self.participant.adminRights?.banUsers)) {
            throw new Error("Ban permission required");
          }
          const targetMembership = await client.invoke(new Api.channels.GetParticipant({
            channel: chat, participant: await client.getInputEntity(target),
          }));
          if (targetMembership.participant instanceof Api.ChannelParticipantCreator ||
              targetMembership.participant instanceof Api.ChannelParticipantAdmin) throw new Error("Admin target");
          await client.invoke(new Api.channels.EditBanned({
            channel: chat, participant: target,
            bannedRights: new Api.ChatBannedRights({
              untilDate: Math.floor(Date.now() / 1000) + seconds,
              viewMessages: false, sendMessages: true, sendMedia: true, sendStickers: true,
              sendGifs: true, sendGames: true, sendInline: true, embedLinks: true,
              sendPolls: true, changeInfo: true, inviteUsers: true, pinMessages: true,
            }),
          }));
          const user = target as ApiTypes.User;
          const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.username || String(user.id);
          await client.sendMessage(raw.peerId, {message:
            `<b>禁言成功</b>\n用户：${escape(name)}\n时长：${seconds} 秒${reason ? `\n理由：${escape(reason)}` : ""}\n到期自动解除`, parseMode: "html"});
          if (typeof raw.delete === "function") {
            try { await raw.delete({revoke: true}); }
            catch { context.log.error("portball_command_cleanup_failed"); }
          }
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("portball_failed");
        await context.telegram.edit(invocation.message, "禁言失败，请确认目标、群组类型和管理员权限");
      }
    }};
  const help = (prefix: string) => renderCommandHelp("portball", command, {prefix, title: "🔇 Portball 临时禁言"});
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "portball", description: "回复消息临时禁言群组成员",
    commands: {portball: command},
  });
}
