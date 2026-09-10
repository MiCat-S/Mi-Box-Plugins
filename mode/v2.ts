import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type PluginContext, type SubcommandDefinition} from "telebox/sdk";
type Mode = "off" | "del" | "bold" | "italic" | "underline" | "mask" | "all";
type Data = {chats: Record<string, Mode>; whitelist: string[]; blacklist: string[]; globalMode: Mode};
const modes = new Set<Mode>(["off", "del", "bold", "italic", "underline", "mask", "all"]);
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);

const store = (ctx: PluginContext) => ctx.storage.json<Data>("config.json", {chats: {}, whitelist: [], blacklist: [], globalMode: "off"});
const labels: Record<Mode, string> = {off: "关闭本地模式", del: "删除线", bold: "加粗", italic: "斜体", underline: "下划线", mask: "遮罩", all: "下划线、加粗、斜体和删除线"};
const withData = (operation: (invocation: CommandInvocation, ctx: PluginContext, data: Data) => Promise<void>): CommandDefinition["handle"] => async (invocation, ctx) => operation(invocation, ctx, await store(ctx).read());
const showHelp = async (invocation: CommandInvocation, ctx: PluginContext) => { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); };
const setMode = (mode: Mode, global: boolean): SubcommandDefinition => ({
  description: mode === "off" && global ? "关闭全局模式" : labels[mode], args: "", examples: [{args: mode}],
  handle: withData(async (invocation, ctx) => {
    if (global) {
      await store(ctx).update(current => ({...current, globalMode: mode}));
      await ctx.telegram.edit(invocation.message, `全局模式已设置为 ${esc(mode)}`, {parseMode: "html"});
    } else {
      await store(ctx).update(current => ({...current, chats: {...current.chats, [invocation.message.chatId]: mode}}));
      await ctx.telegram.edit(invocation.message, `当前会话模式已设置为 ${esc(mode)}`);
    }
  }),
});
const modeTree = (global: boolean) => Object.fromEntries([...modes].map(mode => [mode, setMode(mode, global)]));
const membership = (kind: "whitelist" | "blacklist"): SubcommandDefinition => ({
  description: kind === "whitelist" ? "仅在白名单聊天中启用" : "在黑名单聊天中禁用", args: "", examples: [{args: `${kind} list`}],
  subcommands: {
    list: {description: "查看聊天列表", args: "", examples: [{args: "list"}], handle: withData(async (invocation, ctx, data) => {
      const list = data[kind];
      await ctx.telegram.edit(invocation.message, list.length ? list.map((id, i) => `${i + 1}. <code>${esc(id)}</code>`).join("\n") : "列表为空", {parseMode: "html"});
    })},
    add: {description: "添加当前聊天", args: "", examples: [{args: "add"}], handle: withData(async (invocation, ctx) => {
      await store(ctx).update(current => ({...current, [kind]: [...new Set([...current[kind], invocation.message.chatId])]}));
      await ctx.telegram.edit(invocation.message, "设置已更新");
    })},
    remove: {description: "移除当前聊天", aliases: ["rm"], args: "", examples: [{args: "remove"}], handle: withData(async (invocation, ctx) => {
      await store(ctx).update(current => ({...current, [kind]: current[kind].filter(id => id !== invocation.message.chatId)}));
      await ctx.telegram.edit(invocation.message, "设置已更新");
    })},
  },
  handle: withData(showHelp),
});
const command: CommandDefinition = {
  description: "管理消息格式模式", helpArgs: ["help", "h"], args: "", examples: [{args: "", description: "查看当前会话和全局模式"}],
  subcommandsCaseSensitive: true,
  subcommands: {
    ...modeTree(false),
    global: {description: "查看或设置全局模式", args: "", examples: [{args: "global"}], subcommands: modeTree(true),
      handle: withData(async (invocation, ctx, data) => {
        if (invocation.args.length) { await showHelp(invocation, ctx); return; }
        await ctx.telegram.edit(invocation.message, `<b>全局模式:</b> ${esc(data.globalMode)}`, {parseMode: "html"});
      })},
    whitelist: membership("whitelist"), blacklist: membership("blacklist"),
  },
  help: [{heading: "范围与优先级：", body: "处理自己发出的消息及收藏夹消息，忽略命令，默认不处理编辑消息。白名单非空时仅允许其中聊天，黑名单中的聊天始终禁用。通过名单筛选后，优先使用当前会话模式；本地为 off 时使用全局模式。全局默认为 off。"}],
  handle: withData(async (invocation, ctx, data) => {
    if (invocation.args.length) { await showHelp(invocation, ctx); return; }
    await ctx.telegram.edit(invocation.message, `<b>消息模式</b>\n当前会话: ${esc(data.chats[invocation.message.chatId] ?? "off")}\n全局模式: ${esc(data.globalMode)}`, {parseMode: "html"});
  }),
};
const help = (prefix: string) => renderCommandHelp("mode", command, {prefix, title: "📌 消息模式"});
export default function createMode() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "mode", description: "管理消息格式模式", renderHelp: help,
    listeners: [{direction: "outgoing", includeSaved: true, ignoreCommands: true, async handle(message, ctx) {
      if (!message.text.trim()) return;
      const data = await ctx.storage.json<Data>("config.json", {chats: {}, whitelist: [], blacklist: [], globalMode: "off"}).read();
      if (data.whitelist.length && !data.whitelist.includes(message.chatId)) return;
      if (data.blacklist.includes(message.chatId)) return;
      const local = data.chats[message.chatId] ?? "off";
      const mode = local === "off" ? data.globalMode : local;
      if (mode === "off") return;
      const tags: Record<Exclude<Mode, "off">, [string, string]> = {
        bold: ["<b>", "</b>"], italic: ["<i>", "</i>"], del: ["<s>", "</s>"],
        underline: ["<u>", "</u>"], mask: ['<span class="tg-spoiler">', "</span>"],
        all: ["<u><b><i><s>", "</s></i></b></u>"],
      };
      const [start, end] = tags[mode];
      ctx.signal.throwIfAborted();
      await ctx.telegram.edit(message, start + esc(message.text.trim()) + end, {parseMode: "html"});
    }}],
    commands: {mode: command},
  });
}
