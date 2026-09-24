import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, type MessageEnvelope, type PluginContext } from "telebox/sdk";
import type { Api as ApiTypes } from "teleproto";
import { setTimeout as delay } from "node:timers/promises";

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>\"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!,
  );

function duration(value: string | undefined): number | undefined {
  const match = /^(\d+)([smhd])?$/i.exec(value ?? "");
  if (!match) return undefined;
  const seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2]?.toLowerCase() ?? "s"] ?? 1);
  return Number.isSafeInteger(seconds) && seconds >= 60 && seconds <= 366 * 86400 ? seconds : undefined;
}
type Failure = "ADMIN_REQUIRED" | "USER_ADMIN_INVALID" | "CHANNEL_PRIVATE" | "USER_NOT_PARTICIPANT";
class PortballError extends Error {
  constructor(readonly kind: Failure) {
    super(kind);
  }
}
export function category(error: unknown) {
  const value =
    error instanceof PortballError
      ? error.kind
      : error && typeof error === "object" && "errorMessage" in error
        ? (error as { errorMessage?: unknown }).errorMessage
        : undefined;
  return value === "ADMIN_REQUIRED" || value === "CHAT_ADMIN_REQUIRED"
    ? "需要管理员权限"
    : value === "USER_ADMIN_INVALID"
      ? "无法禁言管理员"
      : value === "CHANNEL_PRIVATE"
        ? "无法在私有频道操作"
        : value === "USER_NOT_PARTICIPANT"
          ? "用户不在群组中"
          : "请确认目标、群组类型和管理员权限";
}
async function errorReceipt(context: PluginContext, message: MessageEnvelope, text: string) {
  await context.telegram.edit(message, text, { parseMode: "html" });
  const raw = message.raw as { delete?: (value: unknown) => Promise<unknown> } | undefined;
  if (!raw?.delete) return;
  void context.tasks
    .run("portball:error-cleanup", async (signal: AbortSignal) => {
      try {
        await delay(5000, undefined, { signal });
        await raw.delete!({ revoke: true });
      } catch {
        if (!signal.aborted) context.log.error("portball_error_cleanup_failed");
      }
    })
    .catch(() => {});
}

export default function createPortball() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "portball",
    description: "回复消息临时禁言群组成员",
    commands: {
      portball: {
        description: "回复消息临时禁言群组成员",
        async handle(invocation, context) {
          const seconds = duration(invocation.args.at(-1));
          if (!seconds || invocation.message.replyToId === undefined) {
            await errorReceipt(
              context,
              invocation.message,
              `<b>临时禁言</b>\n回复目标消息后发送 <code>${escape(invocation.prefix)}portball [理由] 时间</code>\n支持 s、m、h、d，最短 60 秒。`,
            );
            return;
          }
          const reason = invocation.args.slice(0, -1).join(" ").trim();
          try {
            const reply = await context.telegram.getReply(invocation.message);
            if (!reply?.senderId) throw new Error("Missing sender");
            await context.telegram.withClient(async (client, signal) => {
              const { Api } = await import("teleproto");
              const { returnBigInt } = await import("teleproto/Helpers.js");
              signal.throwIfAborted();
              const raw = invocation.message.raw as ApiTypes.Message | undefined;
              if (!raw?.peerId) throw new Error("Missing peer");
              const [chat, target, me] = await Promise.all([
                client.getEntity(raw.peerId),
                client.getEntity(returnBigInt(reply.senderId!)),
                client.getMe(),
              ]);
              signal.throwIfAborted();
              if (!(chat instanceof Api.Channel)) throw new Error("Unsupported chat");
              if (String((target as ApiTypes.User).id) === String(me.id)) throw new Error("Self target");
              const ownMembership = await client.invoke(
                new Api.channels.GetParticipant({
                  channel: chat,
                  participant: new Api.InputPeerSelf(),
                }),
              );
              signal.throwIfAborted();
              if (
                !(ownMembership.participant instanceof Api.ChannelParticipantCreator) &&
                (!(ownMembership.participant instanceof Api.ChannelParticipantAdmin) ||
                  !ownMembership.participant.adminRights?.banUsers)
              ) {
                throw new PortballError("ADMIN_REQUIRED");
              }
              const inputTarget = await client.getInputEntity(target);
              signal.throwIfAborted();
              const targetMembership = await client.invoke(
                new Api.channels.GetParticipant({
                  channel: chat,
                  participant: inputTarget,
                }),
              );
              signal.throwIfAborted();
              if (
                targetMembership.participant instanceof Api.ChannelParticipantCreator ||
                targetMembership.participant instanceof Api.ChannelParticipantAdmin
              )
                throw new PortballError("USER_ADMIN_INVALID");
              signal.throwIfAborted();
              await client.invoke(
                new Api.channels.EditBanned({
                  channel: chat,
                  participant: target,
                  bannedRights: new Api.ChatBannedRights({
                    untilDate: Math.floor(Date.now() / 1000) + seconds,
                    viewMessages: false,
                    sendMessages: true,
                    sendMedia: true,
                    sendStickers: true,
                    sendGifs: true,
                    sendGames: true,
                    sendInline: true,
                    embedLinks: true,
                    sendPolls: true,
                    changeInfo: true,
                    inviteUsers: true,
                    pinMessages: true,
                  }),
                }),
              );
              signal.throwIfAborted();
              const user = target as ApiTypes.User;
              const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.username || String(user.id);
              try {
                await client.sendMessage(raw.peerId, {
                  message: `<b>禁言成功</b>\n用户：${escape(name)}\n时长：${seconds} 秒${reason ? `\n理由：${escape(reason)}` : ""}\n到期自动解除`,
                  parseMode: "html",
                });
              } catch {
                context.log.error("portball_success_receipt_failed");
                return;
              }
              signal.throwIfAborted();
              if (typeof raw.delete === "function") {
                try {
                  await raw.delete({ revoke: true });
                } catch {
                  context.log.error("portball_command_cleanup_failed");
                }
              }
            });
          } catch (error) {
            if (context.signal.aborted) return;
            context.log.error("portball_failed");
            await errorReceipt(context, invocation.message, `❌ <b>禁言失败：</b>${category(error)}`);
          }
        },
      },
    },
  });
}
