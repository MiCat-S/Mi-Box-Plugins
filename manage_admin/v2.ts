import { setTimeout as sleep } from "node:timers/promises";
import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, ui, type MessageEnvelope, type PluginContext } from "telebox/sdk";

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

const inGroup = (message: MessageEnvelope): boolean => {
  const raw = message.raw as { isPrivate?: boolean; isGroup?: boolean; isChannel?: boolean } | undefined;
  return (
    raw?.isPrivate !== true && (message.chatId.startsWith("-") || raw?.isGroup === true || raw?.isChannel === true)
  );
};

const display = (user: any, id: string): string =>
  [user?.firstName, user?.lastName, user?.username && `@${user.username}`]
    .filter(Boolean)
    .map(escape)
    .concat(`<a href="tg://user?id=${escape(id)}">${escape(id)}</a>`)
    .join(" ");

async function deliver(
  context: PluginContext,
  message: MessageEnvelope,
  html: string,
  signal: AbortSignal,
): Promise<void> {
  const rendered = await ui.renderRichText(html, ui.PAGE_LABEL_RESERVE + 1);
  signal.throwIfAborted();
  const raw = rendered.length ? rendered : [html];
  const pages = raw.map((page, index) => page + ui.pageLabel(index, raw.length));
  const delivery = await ui.deliverPages(pages, signal, async (page, index) => {
    signal.throwIfAborted();
    if (index === 0) await context.telegram.edit(message, page, { parseMode: "html" });
    else await context.telegram.reply(message, page, { parseMode: "html" });
  });
  if (!delivery.interrupted) return;
  if (delivery.published === 0) throw delivery.error;
  context.log.error("manage_admin_partial_delivery");
  signal.throwIfAborted();
  try {
    await context.telegram.reply(message, ui.interruptedNotice(delivery));
  } catch {
    context.log.error("manage_admin_delivery_notice_failed");
  }
}

async function run(
  message: MessageEnvelope,
  args: readonly string[],
  prefix: string,
  context: PluginContext,
): Promise<void> {
  if (!inGroup(message)) {
    await context.telegram.edit(message, `请在群组/频道对话中使用 <code>${escape(prefix)}manage_admin</code> 命令`, {
      parseMode: "html",
    });
    return;
  }
  const subcommand = (args[0] ?? "").toLowerCase();
  if (!subcommand || ["help", "h"].includes(subcommand)) {
    await context.telegram.edit(message, renderPluginHelp(prefix), { parseMode: "html" });
    return;
  }

  await context.telegram.withClient(async (client: any, signal) => {
    const { Api } = await import("teleproto");
    signal.throwIfAborted();
    const { returnBigInt } = await import("teleproto/Helpers.js");
    signal.throwIfAborted();
    const raw = message.raw as { peerId?: unknown } | undefined;
    const chatLike = raw?.peerId ?? (/^-?\d+$/.test(message.chatId) ? returnBigInt(message.chatId) : message.chatId);
    const chat = await client.getEntity(chatLike);
    signal.throwIfAborted();
    const channel = await client.getInputEntity(chat);
    signal.throwIfAborted();
    const reply = message.replyToId !== undefined ? await context.telegram.getReply(message) : undefined;
    signal.throwIfAborted();
    const targetToken = reply?.senderId ?? args[1];

    const invoke = async (request: any): Promise<any> => {
      const result = await client.invoke(request);
      signal.throwIfAborted();
      return result;
    };

    const resolveTarget = async (): Promise<{ entity: any; input: any; id: string } | undefined> => {
      if (!targetToken) return undefined;
      try {
        const entity = await client.getEntity(/^-?\d+$/.test(targetToken) ? returnBigInt(targetToken) : targetToken);
        signal.throwIfAborted();
        if (entity?.className !== "User") return undefined;
        const input = await client.getInputEntity(entity);
        signal.throwIfAborted();
        return { entity, input, id: String(entity.id) };
      } catch {
        signal.throwIfAborted();
        if (!/^-?\d+$/.test(targetToken) || chat.className !== "Channel") return undefined;
        let offset = 0;
        for (let page = 0; page < 5; page += 1) {
          signal.throwIfAborted();
          const result = await invoke(
            new Api.channels.GetParticipants({
              channel,
              filter: new Api.ChannelParticipantsRecent(),
              offset,
              limit: 200,
              hash: 0 as any,
            }),
          );
          const participants = result?.participants ?? [];
          const users = result?.users ?? [];
          const participant = participants.find(
            (value: any) => String(value.userId ?? value.peer?.userId) === targetToken,
          );
          const entity = participant && users.find((value: any) => String(value.id) === targetToken);
          if (entity) {
            const input = await client.getInputEntity(entity);
            signal.throwIfAborted();
            return { entity, input, id: String(entity.id) };
          }
          if (!participants.length) break;
          offset += participants.length;
        }
        return undefined;
      }
    };

    if (["ls", "list"].includes(subcommand)) {
      if (chat.className !== "Channel") {
        await context.telegram.edit(message, "仅支持超级群/频道列出管理员");
        return;
      }
      try {
        const result = await invoke(
          new Api.channels.GetParticipants({
            channel,
            filter: new Api.ChannelParticipantsAdmins(),
            offset: 0,
            limit: 200,
            hash: 0 as any,
          }),
        );
        const users = new Map((result.users ?? []).map((user: any) => [String(user.id), user]));
        const lines = (result.participants ?? []).map((participant: any) => {
          const id = String(participant.userId ?? participant.peer?.userId);
          const rank = participant.rank ? ` | 头衔: <code>${escape(participant.rank)}</code>` : "";
          return `- ${display(users.get(id), id)}${rank}`;
        });
        await deliver(
          context,
          message,
          lines.length ? `当前管理员列表：\n${lines.join("\n")}` : "当前对话没有管理员或无法获取",
          signal,
        );
      } catch {
        signal.throwIfAborted();
        context.log.error("manage_admin_list_failed");
        await context.telegram.edit(message, "获取管理员列表失败，请确认当前账号有权查看管理员");
      }
      return;
    }

    if (!["add", "set", "rm", "remove", "del"].includes(subcommand)) {
      await context.telegram.edit(message, renderPluginHelp(prefix), { parseMode: "html" });
      return;
    }

    let allowed = chat.className === "Chat" && (chat.creator === true || chat.adminRights?.addAdmins === true);
    if (chat.className === "Channel") {
      try {
        const permission = await invoke(
          new Api.channels.GetParticipant({ channel, participant: new Api.InputPeerSelf() }),
        );
        const self = permission?.participant;
        allowed =
          self?.className === "ChannelParticipantCreator" ||
          (self?.className === "ChannelParticipantAdmin" && self.adminRights?.addAdmins === true);
      } catch {
        signal.throwIfAborted();
        allowed = false;
      }
    }
    if (!allowed) {
      await context.telegram.edit(message, "权限不足：需要添加管理员权限");
      return;
    }

    const target = await resolveTarget();
    signal.throwIfAborted();
    if (!target) {
      await context.telegram.edit(message, "请回复一条消息或提供 用户ID/用户名");
      return;
    }
    const adding = ["add", "set"].includes(subcommand);
    const title = Array.from((reply ? args.slice(1) : args.slice(2)).join(" "))
      .slice(0, 16)
      .join("");
    let applied = false;
    try {
      if (chat.className === "Channel") {
        await invoke(
          new Api.channels.EditAdmin({
            channel,
            userId: target.input,
            adminRights: new Api.ChatAdminRights(adding ? { banUsers: true } : {}),
            rank: adding ? title : "",
          }),
        );
      } else {
        await invoke(new Api.messages.EditChatAdmin({ chatId: chat.id, userId: target.input, isAdmin: adding }));
      }
      applied = true;
      let appliedRank = title;
      let selfIsCreator = false;
      if (adding && chat.className === "Channel") {
        await sleep(1200, undefined, { signal });
        try {
          const self = (
            await invoke(new Api.channels.GetParticipant({ channel, participant: new Api.InputPeerSelf() }))
          ).participant;
          selfIsCreator = self?.className === "ChannelParticipantCreator";
          const refreshed = (await invoke(new Api.channels.GetParticipant({ channel, participant: target.input })))
            .participant;
          if (["ChannelParticipantAdmin", "ChannelParticipantCreator"].includes(refreshed?.className))
            appliedRank = refreshed.rank ?? "";
        } catch {
          signal.throwIfAborted();
        }
      }
      const rankText =
        adding && title
          ? appliedRank === title
            ? `，头衔：<code>${escape(title)}</code>`
            : `，但头衔未更新。${selfIsCreator ? "可能原因：非超级群或系统暂未同步。" : "可能原因：仅群主可设置头衔；或非超级群；或系统暂未同步。"}`
          : "";
      await context.telegram.edit(
        message,
        `${adding ? "已设置" : "已移除"}管理员: ${display(target.entity, target.id)}${rankText}`,
        { parseMode: "html" },
      );
    } catch {
      signal.throwIfAborted();
      if (applied) {
        context.log.error("manage_admin_receipt_failed");
        return;
      }
      context.log.error("manage_admin_operation_failed");
      await context.telegram.edit(
        message,
        `${adding ? "设置" : "移除"}管理员失败，请确认目标属于当前对话且账号拥有所需权限`,
      );
    }
  });
}

export default function createManageAdmin() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "manage_admin",
    description: "添加、移除和列出群组管理员",
    commands: {
      manage_admin: {
        helpArgs: ["help", "h"],
        helpOnEmpty: true,
        description: "管理管理员",
        ignoreEdited: true,
        async handle({ message, args, prefix }, context) {
          await run(message, args, prefix, context);
        },
      },
    },
  });
}
