import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition} from "telebox/sdk";

const command: CommandDefinition = {
  description: "查看归档状态和数据库信息", helpArgs: ["help", "h"], helpOnEmpty: true,
  subcommandsCaseSensitive: false,
  subcommands: {
    db: {description: "查看数据库信息", args: "", examples: [{args: "db"}], async handle(invocation, ctx) {
      ctx.storage.sqlite("leech.sqlite");
      await ctx.telegram.edit(invocation.message, "Leech 数据库已启用：<code>assets/leech.sqlite</code>", {parseMode: "html"});
    }},
    stats: {description: "列出归档数据库中的数据表与行数", args: "", examples: [{args: "stats"}], async handle(invocation, ctx) {
      const db = ctx.storage.sqlite("leech.sqlite");
        const result = await db.read(connection => {
          const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{name: string}>;
          return tables.map(table => {
            const name = table.name.replace(/"/g, "\"\"");
            const row = connection.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as {count: number};
            return `${table.name}: ${row.count}`;
          });
        });
        await ctx.telegram.edit(invocation.message, `<b>Leech 统计</b>\n${result.join("\n") || "暂无数据"}`, {parseMode: "html"});
        return;

    }},
    session: {description: "检查当前 Telegram 会话", args: "", examples: [{args: "session"}], async handle(invocation, ctx) {
      ctx.storage.sqlite("leech.sqlite");
      const me = await ctx.telegram.withClient(client => client.getMe());
      await ctx.telegram.edit(invocation.message, `<b>Telegram 会话正常</b>\n账号：<code>${String((me as {id?: unknown})?.id ?? "unknown")}</code>`, {parseMode: "html"});
    }},
  },
  help: [{heading: "功能范围：", body: "查看当前账号会话状态与本地归档数据库统计。当前版本提供归档状态查询；历史消息抓取及任务管理尚未实现。"}],
  async handle(invocation, ctx) {
    const sub = invocation.args[0]?.toLowerCase() ?? "help";
    if (sub === "help" || sub === "h") { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    ctx.storage.sqlite("leech.sqlite");
    await ctx.telegram.edit(invocation.message, "未知子命令，请使用 .leech help");
  },
};
const help = (prefix: string) => renderCommandHelp("leech", command, {prefix, title: "🗃️ Leech 归档状态"});
export default function createLeech() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "leech", description: "历史消息归档与抓取工具", renderHelp: help, commands: {leech: command}});
}
