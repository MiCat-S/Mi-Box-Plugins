import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type PluginContext, type SubcommandDefinition} from "telebox/sdk";

const base = "https://raw.githubusercontent.com/MiCat-S/Mi-Box-Plugins/main/fadian/";
const files: Readonly<Record<string, string>> = {fd: "psycho.json", tg: "tg.json", kfc: "kfc.json", wyy: "wyy.json", cp: "cp.json"};
type Cache = Map<string, {at: number; values: string[]}>;
const TTL = 5 * 60_000;
const MAX_ITEMS = 20_000;
const MAX_ITEM_LENGTH = 4_000;

function escape(value: string): string {
  return value.replace(/[&<>"]/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"})[char]!);
}

async function list(ctx: PluginContext, kind: string, cache: Cache): Promise<string[]> {
  const previous = cache.get(kind);
  if (previous && Date.now() - previous.at < TTL) return previous.values;
  const data = await ctx.http.json<unknown>(base + files[kind], {method: "GET", redirect: "manual", credentials: "omit"}, {timeoutMs: 10_000, signal: ctx.signal, redirects:{allowedHosts:["raw.githubusercontent.com"],maxRedirects:2}});
  if (!Array.isArray(data)) throw new Error("语录数据格式无效");
  const values = data.filter((value): value is string => typeof value === "string" && value.length <= MAX_ITEM_LENGTH).slice(0, MAX_ITEMS);
  if (!values.length) throw new Error("语录数据为空");
  cache.set(kind, {at: Date.now(), values});
  return values;
}

function names(args: readonly string[], reply?: string): string[] {
  const values = args.join(" ").trim().split(/\s+/).filter(Boolean);
  if (values.length) return values;
  return reply?.trim().split(/\s+/).filter(Boolean) ?? [];
}

export default function createFadian() {
  const cache: Cache = new Map();
  const emit = async (invocation: any, ctx: PluginContext, kind: string, target?: string, pair?: string[]) => {
    const values = await list(ctx, kind, cache);
    let text = values[Math.floor(Math.random() * values.length)]!;
    if (kind === "cp") text = text.replaceAll("<name1>", pair![0]!).replaceAll("<name2>", pair![1]!);
    else text = text.replaceAll("<name>", target ?? "");
    await ctx.telegram.edit(invocation.message, escape(text), {parseMode: "html"});
  };
  const fail = async (invocation: any, ctx: PluginContext, error: unknown) => {
    if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `<b>发电失败</b>\n${escape(error instanceof Error ? error.message : "请稍后重试")}`, {parseMode: "html"});
  };
  const simple = (kind: string, description: string): SubcommandDefinition => ({
    description, args: "", examples: [{args: kind}],
    async handle(invocation, ctx) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) { await ctx.telegram.edit(invocation.message, renderCommandHelp("fadian", fadianCommand, {prefix: invocation.prefix, title: "🗒️ 发电语录插件"}), {parseMode: "html"}); return; }
      try { await emit(invocation, ctx, kind); } catch (error) { await fail(invocation, ctx, error); }
    },
  });
  const fd: SubcommandDefinition = {
    description: "心理语录（回复消息时自动获取对方昵称）", args: "[名字]",
    examples: [{args: "fd 张三"}, {args: "fd", description: "回复消息自动获取昵称"}],
    async handle(invocation, ctx) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) { await ctx.telegram.edit(invocation.message, renderCommandHelp("fadian", fadianCommand, {prefix: invocation.prefix, title: "🗒️ 发电语录插件"}), {parseMode: "html"}); return; }
      try {
        let target = invocation.args.join(" ").trim();
        if (!target) {
          const reply = await ctx.telegram.getReply(invocation.message);
          if (reply) {
            const raw = reply.raw as {sender?: {firstName?: string; lastName?: string; title?: string; username?: string}} | undefined;
            const sender = raw?.sender;
            target = [sender?.firstName, sender?.lastName].filter(Boolean).join(" ").trim() || sender?.title || sender?.username || "Ta";
          }
        }
        if (!target) throw new Error("请提供名字或回复一条消息");
        await emit(invocation, ctx, "fd", target);
      } catch (error) { await fail(invocation, ctx, error); }
    },
  };
  const cp: SubcommandDefinition = {
    description: "CP 语录（第二行/第三行为两个名字）", args: "[名字1 名字2]",
    examples: [{args: "cp 张三 李四"}],
    help: [{heading: "CP 多行示例：", body: "<pre>{prefix}fadian cp\n第一个人\n第二个人</pre>"}],
    async handle(invocation, ctx) {
      if (["help", "h"].includes(invocation.args[0]?.toLowerCase() ?? "")) { await ctx.telegram.edit(invocation.message, renderCommandHelp("fadian", fadianCommand, {prefix: invocation.prefix, title: "🗒️ 发电语录插件"}), {parseMode: "html"}); return; }
      try {
        const lines = invocation.message.text.split(/\r?\n/);
        const pair = names(invocation.args, lines.slice(1, 3).join(" "));
        if (pair.length < 2) throw new Error("CP 语录需要两个人名");
        await emit(invocation, ctx, "cp", undefined, pair);
      } catch (error) { await fail(invocation, ctx, error); }
    },
  };
  const clear: SubcommandDefinition = {
    description: "清理缓存并重新下载", args: "", examples: [{args: "clear"}],
    async handle(invocation, ctx) { cache.clear(); await ctx.telegram.edit(invocation.message, "发电语录缓存已清理"); },
  };
  const fadianCommand: CommandDefinition = {
    description: "随机生成发电语录",
    helpOnEmpty: true,
    helpArgs: ["help", "h"],
    subcommandsCaseSensitive: false,
    subcommands: {fd, tg: simple("tg", "TG 语录"), kfc: simple("kfc", "KFC 语录"), wyy: simple("wyy", "网抑云语录"), cp, clear},
    examples: [{args: "fd 张三"}, {args: "fd"}, {args: "tg"}, {args: "kfc"}, {args: "wyy"}, {args: "cp 张三 李四"}, {args: "clear"}],
    help: [
      {heading: "说明：", body: "从远程配置随机生成发电语录；fd 回复消息时自动获取对方昵称；clear 清理缓存并重新下载。"},
    ],
    async handle(invocation, ctx) {
      const first = invocation.args[0]?.toLowerCase();
      if (!first || first === "help" || first === "h") { await ctx.telegram.edit(invocation.message, renderCommandHelp("fadian", fadianCommand, {prefix: invocation.prefix, title: "🗒️ 发电语录插件"}), {parseMode: "html"}); return; }
      await ctx.telegram.edit(invocation.message, "未知子命令，请使用 fadian help");
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "fadian", description: "随机生成发电语录",
    cleanup() {cache.clear();},
    renderHelp: prefix => renderCommandHelp("fadian", fadianCommand, {prefix, title: "🗒️ 发电语录插件"}),
    commands: {fadian: fadianCommand}});
}
