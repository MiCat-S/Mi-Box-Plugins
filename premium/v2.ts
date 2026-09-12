import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin} from "telebox/sdk";
import type {Api} from "teleproto";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

const run = (force: boolean): CommandDefinition["handle"] => async (invocation, context) => {
  if (invocation.args.length) { await context.telegram.edit(invocation.message, "参数无效，请使用 <code>premium [force]</code>", {parseMode: "html"}); return; }
      try {
        await context.telegram.edit(invocation.message, "正在统计群组成员…");
        await context.telegram.withClient(async (client, signal) => {
          const {Api} = await import("teleproto");
          const raw = invocation.message.raw as Api.Message | undefined;
          if (!raw?.peerId) throw new Error("Missing peer");
          const chat = await client.getEntity(raw.peerId);
          if (!(chat instanceof Api.Chat || chat instanceof Api.Channel)) throw new Error("Not a group");
          let participantCount = "participantsCount" in chat && typeof chat.participantsCount === "number" ? chat.participantsCount : 0;
          if (chat instanceof Api.Channel) {
            try {
              const full = await client.invoke(new Api.channels.GetFullChannel({channel: chat}));
              participantCount = Number((full.fullChat as {participantsCount?: unknown}).participantsCount ?? participantCount);
            } catch { context.log.error("premium_count_failed"); }
          }
          if (participantCount >= 10_000 && !force) {
            await context.telegram.edit(invocation.message, `<b>群组人数较多</b>\n使用 <code>${escape(invocation.prefix)}premium force</code> 统计前 10,000 名成员`, {parseMode: "html"});
            return;
          }
          let premium = 0, users = 0, bots = 0, deleted = 0, processed = 0;
          for await (const participant of client.iterParticipants(chat, {limit: 10_000})) {
            signal.throwIfAborted();
            processed++;
            const user = participant as Api.User;
            if (user.bot) bots++;
            else if (user.deleted) deleted++;
            else { users++; if (user.premium) premium++; }
            if (processed % 500 === 0) await context.telegram.edit(invocation.message, `正在统计群组成员… ${processed}`);
          }
          const percent = users ? (premium / users * 100).toFixed(2) : "0.00";
          const limited = participantCount >= 10_000 || processed >= 10_000 ? "\n\n<i>Telegram 最多返回前 10,000 名成员，结果可能不完整。</i>" : "";
          await context.telegram.edit(invocation.message,
            `<b>Premium 统计</b>\nPremium：<b>${premium}</b> / ${users}（<b>${percent}%</b>）\n过滤 Bot ${bots} · 已注销 ${deleted}\n处理成员 ${processed}${limited}`,
            {parseMode: "html"});
        });
      } catch {
        if (context.signal.aborted) return;
        context.log.error("premium_scan_failed");
        await context.telegram.edit(invocation.message, "<b>统计失败</b>\n请确认当前会话是可访问成员列表的群组", {parseMode: "html"});
      }

};
const command: CommandDefinition = {
  helpArgs: ["help", "h"], description: "统计群组 Telegram Premium 用户比例", args: "", examples: [{args: ""}], subcommandsCaseSensitive: true,
  subcommands: {force: {description: "大型群组强制统计前 10,000 名成员", args: "", examples: [{args: "force"}], handle: run(true)}},
  help: [{heading: "统计口径：", body: "自动过滤机器人和已注销账号，显示 Premium 人数、正常用户总数和比例。群组达到 10,000 人时需 force，最多读取前 10,000 名成员，结果可能不完整；需要当前账号能访问成员列表。"}],
  async handle(invocation, context) {
    if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    await run(false)(invocation, context);
  },
};
const help = (prefix: string) => renderCommandHelp("premium", command, {prefix, title: "🎁 群组大会员统计"});
export default function createPremium() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "premium", description: "统计群组 Telegram Premium 用户比例", renderHelp: help, commands: {premium: command}});
}
