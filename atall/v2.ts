import {renderHelp as renderPluginHelp} from "./v2/help";
import {setTimeout as delay} from "node:timers/promises";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition} from "telebox/sdk";
import type {Api} from "teleproto";

const MAX_MENTIONS = 250;
const MAX_PAGES = 10;
const MAX_MENTIONS_PER_PAGE = 25;
const MAX_PAGE_CHARS = 3300;
const PAGE_HEADER = "<b>@所有人:</b>\n";
const TRUNCATION_NOTICE = `\n\n<i>已达到单次 ${MAX_MENTIONS} 人 / ${MAX_PAGES} 页上限，剩余成员未发送。</i>`;

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function mention(user: Api.User): string | undefined {
  if (user.bot || user.deleted) return undefined;
  if (user.username) return `@${escape(user.username)}`;
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return name ? `<a href="tg://user?id=${user.id}">${escape(name)}</a>` : undefined;
}

interface PagePlan {
  pages: string[];
  included: number;
  truncated: boolean;
}

function planPages(values: readonly string[], sourceTruncated: boolean): PagePlan {
  const result: string[] = [];
  const contentLimit = MAX_PAGE_CHARS - TRUNCATION_NOTICE.length;
  let current = PAGE_HEADER;
  let currentCount = 0;
  let included = 0;
  let truncated = sourceTruncated;

  for (const value of values) {
    const addition = `${currentCount ? " " : ""}${value}`;
    if (currentCount >= MAX_MENTIONS_PER_PAGE || current.length + addition.length > contentLimit) {
      if (!currentCount || result.length >= MAX_PAGES - 1) {
        truncated = true;
        break;
      }
      result.push(current);
      current = PAGE_HEADER;
      currentCount = 0;
    }
    current += `${currentCount ? " " : ""}${value}`;
    currentCount += 1;
    included += 1;
  }

  if (currentCount) result.push(current);
  if (truncated && result.length) result[result.length - 1] += TRUNCATION_NOTICE;
  return {pages: result, included, truncated};
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  let detail: string;
  if (message.includes("CHAT_ADMIN_REQUIRED")) {
    detail = "需要管理员权限来获取成员列表";
  } else if (message.includes("USER_NOT_PARTICIPANT")) {
    detail = "不是群组成员";
  } else if (message.includes("CHANNEL_PRIVATE")) {
    detail = "无法访问私有频道";
  } else {
    detail = "暂时无法获取群组成员，请稍后重试";
  }
  return `❌ <b>发生错误:</b> ${detail}`;
}

export default function createAtAll() {
  let busy = false;
  const atallCommand: CommandDefinition = {
    description: "在群组中提醒所有可见成员",
    helpArgs: ["help", "h"],
    args: "",
    arguments: [],
    examples: [{args: "", description: "在群组中 @所有可见成员"}],
    help: [
      {
        heading: "功能描述：",
        body: "• 一键@群组中的可见普通成员、管理员和账号本人\n" +
          "• 自动跳过 Bot、已删除账号和无可用名称的成员\n" +
          `• 每次最多处理 ${MAX_MENTIONS} 人、发送 ${MAX_PAGES} 条消息`,
      },
      {
        heading: "执行限制：",
        body: `• 每页最多 ${MAX_MENTIONS_PER_PAGE} 个 mention、${MAX_PAGE_CHARS} 字符\n` +
          "• 同一时间只执行一个 AtAll 任务\n" +
          "• 达到上限时停止并在末页提示截断",
      },
      {
        heading: "注意事项：",
        body: "• 大量提醒有封号和 Telegram 频率限制风险，后果自负\n" +
          "• 一般可优先使用置顶消息提醒成员",
      },
    ],
    async handle(invocation, context) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
        await context.telegram.edit(invocation.message,
          renderPluginHelp(invocation.prefix, MAX_MENTIONS, MAX_PAGES, MAX_MENTIONS_PER_PAGE, MAX_PAGE_CHARS),
          {parseMode: "html"});
        return;
      }
      if (busy) {
        await context.telegram.edit(invocation.message, "已有 AtAll 任务正在执行，请稍后再试");
        return;
      }

      busy = true;
      try {
        const raw = invocation.message.raw as Api.Message | undefined;
        if (!raw?.peerId) throw new Error("Missing peer");
        if (invocation.message.chatType === "private" || invocation.message.chatType === "broadcast" ||
            raw.peerId.className === "PeerUser") {
          await context.telegram.edit(invocation.message, "❌ 此命令只能在群组中使用", {parseMode: "html"});
          return;
        }

        await context.telegram.edit(invocation.message, "🔄 正在获取群组成员列表...", {parseMode: "html"});
        await context.telegram.withClient(async (client, signal) => {
          const peer = raw.peerId;
          const participants: AsyncIterable<unknown> = typeof client.iterParticipants === "function"
            ? client.iterParticipants(peer, {limit: MAX_MENTIONS + 1, showTotal: false})
            : (async function* () {
                const loaded = await client.getParticipants(peer, {limit: MAX_MENTIONS + 1, showTotal: false});
                for (const participant of loaded) yield participant;
              })();
          const mentions: string[] = [];
          let inspected = 0;
          let sourceTruncated = false;
          for await (const participant of participants) {
            signal.throwIfAborted();
            if (inspected >= MAX_MENTIONS) {
              sourceTruncated = true;
              break;
            }
            inspected += 1;
            const value = mention(participant as Api.User);
            if (value) mentions.push(value);
          }

          if (!inspected) {
            await context.telegram.edit(invocation.message, "❌ 无法获取群组成员或群组为空", {parseMode: "html"});
            return;
          }
          const output = planPages(mentions, sourceTruncated);
          if (!output.included) {
            await context.telegram.edit(invocation.message, "❌ 没有可@的成员", {parseMode: "html"});
            return;
          }
          await context.telegram.edit(invocation.message,
            `🔄 正在生成@列表... (${output.included} 个成员)`, {parseMode: "html"});

          for (let index = 0; index < output.pages.length; index += 1) {
            signal.throwIfAborted();
            await client.sendMessage(peer, {
              message: output.pages[index]!,
              parseMode: "html",
              replyTo: index === 0 ? invocation.message.id : undefined,
              topMsgId: invocation.message.topicId,
            });
            if (index + 1 < output.pages.length) await delay(500, undefined, {signal});
          }
          if (typeof raw.delete === "function") {
            signal.throwIfAborted();
            try {
              await raw.delete({revoke: true});
            } catch {
              if (!signal.aborted) context.log.info("atall_receipt_cleanup_failed");
            }
          }
        });
      } catch (error) {
        if (context.signal.aborted) return;
        context.log.error("atall_failed");
        await context.telegram.edit(invocation.message, failureMessage(error), {parseMode: "html"});
      } finally {
        busy = false;
      }
    },
  };

  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "atall",
    description: "在群组中提醒所有可见成员",
    renderHelp: prefix => renderPluginHelp(prefix, MAX_MENTIONS, MAX_PAGES, MAX_MENTIONS_PER_PAGE, MAX_PAGE_CHARS),
    commands: {atall: atallCommand},
  });
}
