import {definePlugin} from "telebox/sdk";
import {archive, ensureDatabase, jobs, session, stats} from "./v2/archive";
import {renderHelp} from "./v2/help";
import {parseArchiveInput} from "./v2/input";

export default function createLeech() {
  return definePlugin({
    renderHelp,
    apiVersion: 1,
    id: "leech",
    description: "历史消息归档与抓取工具",
    async setup(context) {
      await ensureDatabase(context, true);
    },
    commands: {
      leech: {
        helpArgs: ["help", "h"],
        helpOnEmpty: true,
        description: "归档聊天历史并查看任务",
        async handle(invocation, context) {
          const subcommand = invocation.args[0]?.toLowerCase() ?? "help";
          if (subcommand === "help" || subcommand === "h") {
            await context.telegram.edit(invocation.message, renderHelp(invocation.prefix), {parseMode: "html"});
            return;
          }
          if (subcommand === "session" || subcommand === "login") {
            await session(invocation, context);
            return;
          }
          if (["chat", "group", "messages"].includes(subcommand)) {
            const input = parseArchiveInput(invocation.args.slice(1));
            if (!input) {
              await context.telegram.edit(invocation.message,
                "❌ 参数无效：请提供 --from YYYY-MM-DD --to YYYY-MM-DD，并检查 limit/batch");
              return;
            }
            await archive(invocation, context, input);
            return;
          }
          if (subcommand === "jobs") {
            await jobs(invocation, context);
            return;
          }
          if (subcommand === "stats") {
            await stats(invocation, context);
            return;
          }
          if (subcommand === "db") {
            await context.telegram.edit(invocation.message,
              "🗄️ Leech SQLite DB:\n<code>assets/leech/leech.sqlite</code>", {parseMode: "html"});
            return;
          }
          await context.telegram.edit(invocation.message,
            `❌ Unknown Leech 子命令\n\n${renderHelp(invocation.prefix)}`, {parseMode: "html"});
        },
      },
    },
  });
}
