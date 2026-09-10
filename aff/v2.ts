import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type MessageEnvelope, type PluginContext} from "telebox/sdk";

type Entry = {text: string; webPage?: boolean; web_page?: boolean; created_at?: number};
type Data = {affs: Entry[]; aff?: Entry};
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
const store = (ctx: PluginContext) => ctx.storage.json<Data>("data.json", {affs: []});
async function output(ctx: PluginContext, message: MessageEnvelope, item: Entry) {
  await ctx.telegram.edit(message, item.text, {
    parseMode: item.webPage === undefined && item.web_page !== undefined ? "html" : undefined,
    linkPreview: !(item.webPage ?? item.web_page ?? false),
  });
}
async function list(ctx: PluginContext, message: MessageEnvelope, entries: Entry[], pageArg = "1") {
  const count = Math.max(1, Math.ceil(entries.length / 10));
  const page = Number(pageArg);
  if (!/^[1-9]\d*$/.test(pageArg) || !Number.isSafeInteger(page) || page > count) {
    await ctx.telegram.edit(message, `页码无效，共 ${count} 页`); return;
  }
  const text = entries.slice((page - 1) * 10, page * 10).map((item, i) => {
    const chars = Array.from(item.text.replace(/\s+/g, " "));
    return `${(page - 1) * 10 + i + 1}. ${esc(chars.slice(0, 30).join(""))}${chars.length > 30 ? "..." : ""}`;
  }).join("\n");
  await ctx.telegram.edit(message, `<b>Aff 列表</b> · ${page}/${count}\n\n${text || "暂无 Aff 信息"}`, {parseMode: "html", linkPreview: false});
}

export default function createAff() {
  const listCommand = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const data = await store(ctx).read();
    return list(ctx, invocation.message, data.affs, invocation.args[0]);
  };
  const save = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const db = store(ctx);
    const reply = await ctx.telegram.getReply(invocation.message);
    if (!reply?.text.trim()) { await ctx.telegram.edit(invocation.message, "请回复要保存的消息"); return; }
    if (reply.text.length > 4000) { await ctx.telegram.edit(invocation.message, "文本超过 4000 字符，未保存，请缩短后重试"); return; }
    let full = false;
    await db.update(current => {
      if (current.affs.length >= 32) {full = true; return current;}
      return {...current, affs: [...current.affs, {text: reply.text, webPage: /https?:\/\/[^\s]+/.test(reply.text), created_at: Date.now()}]};
    });
    if (full) { await ctx.telegram.edit(invocation.message, "已保存 32 条，请先删除不需要的记录再保存"); return; }
    await ctx.telegram.edit(invocation.message, "Aff 信息已保存");
  };
  const remove = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const raw = invocation.args[0];
    const index = Number(raw) - 1;
    if (!/^[1-9]\d*$/.test(raw ?? "") || !Number.isSafeInteger(index)) { await ctx.telegram.edit(invocation.message, "序号无效"); return; }
    let removed = false;
    await store(ctx).update(current => {
      if (index >= current.affs.length) return current;
      removed = true;
      return {...current, affs: current.affs.filter((_, i) => i !== index)};
    });
    await ctx.telegram.edit(invocation.message, removed ? "Aff 信息已删除" : "序号无效");
  };
  const affCommand: CommandDefinition = {
    description: "管理并发送 Aff 信息",
    helpArgs: ["help", "h"],
    args: "[序号]",
    arguments: [{name: "序号", description: "发送指定序号的 aff；省略时发送唯一 aff 或显示列表"}],
    examples: [{args: ""}, {args: "2"}, {args: "list"}, {args: "save"}, {args: "remove 1"}],
    help: [
      {heading: "列表与容量：", body: "列表每页 10 条，可用页码参数翻页；最多保存 32 条，每条文本最多 4000 字符；序号从 1 开始。"},
      {heading: "保存：", body: "save 需先回复一条消息；保存后的 aff 可带链接，发送默认 aff 时只发唯一一条或列出全部。"},
    ],
    subcommandsCaseSensitive: false,
    subcommands: {
      list: {description: "查看所有已保存的 aff", args: "[页码]", arguments: [{name: "页码", description: "从 1 开始，每页 10 条"}], examples: [{args: "list"}, {args: "list 2"}], handle: listCommand},
      save: {description: "回复一条消息以新增 aff", args: "", examples: [{args: "save"}], handle: save},
      remove: {aliases: ["rm", "del"], description: "删除指定 aff", args: "序号", arguments: [{name: "序号", required: true, description: "从 1 开始"}], examples: [{args: "remove 1"}], handle: remove},
    },
    async handle(invocation, ctx) {
      const db = store(ctx);
      const args = invocation.args;
      if (!args.length || args[0] === "help" || args[0] === "h") {
        if (!args.length) {
          const data = await db.read();
          if (data.affs.length === 1) return output(ctx, invocation.message, data.affs[0]);
          if (data.affs.length > 1) return list(ctx, invocation.message, data.affs);
        }
        await ctx.telegram.edit(invocation.message, renderCommandHelp("aff", affCommand, {prefix: invocation.prefix}), {parseMode: "html"}); return;
      }
      const data = await db.read();
      const index = Number(args[0].toLowerCase()) - 1;
      if (Number.isInteger(index) && data.affs[index]) return output(ctx, invocation.message, data.affs[index]);
      await ctx.telegram.edit(invocation.message, renderCommandHelp("aff", affCommand, {prefix: invocation.prefix}), {parseMode: "html"});
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "aff", description: "管理并发送 Aff 信息",
    async setup(ctx) {
      const db = store(ctx);
      if ((await db.read()).aff) await db.update(current => {
        if (!current.aff) return current;
        const {aff, ...rest} = current;
        return {...rest, affs: [...(current.affs ?? []), aff]};
      });
    },
    renderHelp: prefix => renderCommandHelp("aff", affCommand, {prefix, title: "✈️ 机场Affiliate信息管理",
      intro: "在别人要打算买机场的时候光速发出自己的aff信息（支持多条）"}),
    commands: {aff: affCommand},
  });
}
