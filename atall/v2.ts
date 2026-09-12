import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition} from "telebox/sdk";
import {setTimeout as delay} from "node:timers/promises";
import type {Api} from "teleproto";

const MAX_MENTIONS = 250;
const MAX_PAGES = 10;
const MAX_PAGE_CHARS = 3300;
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function mention(user: Api.User): string | undefined {
  if (user.bot || user.deleted) return undefined;
  if (user.username) return `@${escape(user.username)}`;
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return name ? `<a href="tg://user?id=${user.id}">${escape(name)}</a>` : undefined;
}

export default function createAtAll() {
  let busy = false;
  const atallCommand: CommandDefinition = {
    description: "在群组中提醒所有可见成员",
    helpArgs: ["help", "h"],
    args: "",
    arguments: [],
    examples: [{args: "", description: "在群组中 @所有人"}],
    chats: ["group", "supergroup"],
    help: [
      {
        heading: "功能描述：",
        body: `• 一键@群组中的可见成员\n• 自动处理无用户名用户\n• 每次最多 ${MAX_MENTIONS} 人、${MAX_PAGES} 条消息`,
      },
      {
        heading: "注意事项：",
        body: "• 极大封号风险，后果自负\n• 超过单次上限时会停止并提示截断\n• 一般来说你可以通过置顶消息来提醒所有人的",
      },
    ],
    async handle(invocation, context) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) {
        await context.telegram.edit(invocation.message, renderCommandHelp("atall", atallCommand, {prefix: invocation.prefix}), {parseMode: "html"});
        return;
      }
      if (busy) { await context.telegram.edit(invocation.message, "已有 AtAll 任务正在执行，请稍后再试"); return; }
      busy = true;
      try {
        await context.telegram.edit(invocation.message, "正在获取群组成员…");
        await context.telegram.withClient(async (client, signal) => {
          const raw = invocation.message.raw as Api.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          let current = "<b>@所有人</b>\n", currentCount = 0, mentioned = 0, published = 0, truncated = false;
          const publish = async (): Promise<void> => {
            if (!currentCount) return;
            if (published) await delay(500, undefined, {signal});
            signal.throwIfAborted();
            await client.sendMessage(raw.peerId!, {message: current, parseMode: "html", replyTo: published ? undefined : invocation.message.id});
            published += 1;
            current = "<b>@所有人（续）</b>\n";
            currentCount = 0;
          };
          const participants: AsyncIterable<unknown> = typeof client.iterParticipants === "function"
            ? client.iterParticipants(raw.peerId)
            : (async function* () { for (const participant of await client.getParticipants(raw.peerId!, {})) yield participant; })();
          for await (const participant of participants) {
            signal.throwIfAborted();
            if (mentioned >= MAX_MENTIONS) { truncated = true; break; }
            const value = mention(participant as Api.User);
            if (!value) continue;
            const next = `${current}${currentCount ? " " : ""}${value}`;
            if (currentCount >= 25 || next.length > MAX_PAGE_CHARS) {
              if (published >= MAX_PAGES - 1) { truncated = true; break; }
              await publish();
            }
            current += `${currentCount ? " " : ""}${value}`;
            currentCount += 1;
            mentioned += 1;
          }
          if (!mentioned) {
            await context.telegram.edit(invocation.message, "没有找到可提醒的成员");
            return;
          }
          if (truncated) current += `\n\n<i>已达到单次 ${MAX_MENTIONS} 人 / ${MAX_PAGES} 页上限，剩余成员未发送。</i>`;
          await publish();
          if (typeof raw.delete === "function") {
            try { await raw.delete({revoke: true}); }
            catch { if (!signal.aborted) context.log.info("atall_receipt_cleanup_failed"); }
          }
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("atall_failed");
        await context.telegram.edit(invocation.message, "<b>提醒失败</b>\n请确认当前会话是可访问成员列表的群组", {parseMode: "html"});
      } finally { busy = false; }
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "atall", description: "在群组中提醒所有可见成员",
    renderHelp: prefix => renderCommandHelp("atall", atallCommand, {prefix, title: "📢 AtAll",
      intro: "一键@群组中的可见成员；自动处理无用户名用户并按安全上限分割消息。"}),
    commands: {atall: atallCommand}});
}
