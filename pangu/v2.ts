import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, type SubcommandDefinition, definePlugin, type PluginContext, type CommandInvocation, type MessageEnvelope} from "telebox/sdk";
type Data = {legacyImported?: boolean; chats: Record<string, boolean>; globalMode: boolean; whitelist: string[]; blacklist: string[]; stats: {formattedMessages: number; lastFormatted: number | null}};
const normalize = (data: Partial<Data>): Data => ({
  chats: {}, globalMode: false, whitelist: [], blacklist: [], ...data,
  stats: {formattedMessages: 0, lastFormatted: null, ...data.stats},
});
const rawStore = (ctx: PluginContext) => ctx.storage.json<Partial<Data>>("data.json", {});
const store = (ctx: PluginContext) => {
  const db = rawStore(ctx);
  return {
    async read() {return normalize(await db.read());},
    update(change: (data: Data) => Data) {return db.update(data => change(normalize(data)));},
  };
};
const CJK = "\\u2e80-\\u2eff\\u2f00-\\u2fdf\\u3040-\\u309f\\u30a0-\\u30fa\\u30fc-\\u30ff\\u3100-\\u312f\\u3200-\\u32ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
const ANS = "a-z0-9`~!$^&*\\-=+\\\\|;,.?/";
const rules: [RegExp, string][] = [
  [new RegExp(`([${CJK}])(["'])`, "g"), "$1 $2"],
  [new RegExp(`(["'])([${CJK}])`, "g"), "$1 $2"],
  [/(["'])\s*(.+?)\s*(["'])/g, "$1$2$3"],
  [new RegExp(`([${CJK}])(#(\\S+))`, "g"), "$1 $2"],
  [new RegExp(`((\\S+)#)([${CJK}])`, "g"), "$1 $3"],
  [new RegExp(`([${CJK}])([${ANS}])`, "gi"), "$1 $2"],
  [new RegExp(`([${ANS}])([${CJK}])`, "gi"), "$1 $2"],
  [new RegExp(`([${CJK}])([\\(\\[\\{<>\\u201c])`, "g"), "$1 $2"],
  [new RegExp(`([\\)\\]\\}>\\u201d])([${CJK}])`, "g"), "$1 $2"],
  [/([(\[{<>\u201c]+)(\s*)(.+?)(\s*)([)\]}>"\u201d]+)/g, "$1$3$5"],
  [new RegExp(`([${CJK}])([${ANS}]+)([${CJK}])`, "gi"), "$1 $2 $3"],
  [new RegExp(`([${ANS}]+)([${CJK}])([${ANS}]+)`, "gi"), "$1 $2 $3"],
];
const hasCjk = new RegExp(`[${CJK}]`);
function spacing(input: string): string {
  if (!hasCjk.test(input)) return input;
  return input.split(/(https?:\/\/\S+)/gi).map((part, index) => {
    if (index % 2 || !hasCjk.test(part)) return part;
    for (const [pattern, replacement] of rules) part = part.replace(pattern, replacement);
    return part;
  }).join("");
}
export default function createPangu() {
  const showHelp: CommandDefinition["handle"] = async (i, ctx) => { await ctx.telegram.edit(i.message, help(i.prefix), {parseMode: "html"}); };
  const toggle = (enabled: boolean, global = false): SubcommandDefinition => ({
    description: `${enabled ? "开启" : "关闭"}${global ? "全局" : "当前会话"}自动格式化`, args: "",
    ...(!global ? {aliases: enabled ? ["enable", "true"] : ["disable", "false"]} : {}),
    async handle(i, ctx) {
      if (global) {
        await store(ctx).update(data => ({...data, globalMode: enabled}));
        await ctx.telegram.edit(i.message, `全局格式化已${enabled ? "开启" : "关闭"}`);
      } else {
        await store(ctx).update(data => ({...data, chats: {...data.chats, [i.message.chatId]: enabled}}));
        await ctx.telegram.edit(i.message, enabled ? "当前会话已开启自动格式化" : "当前会话已关闭自动格式化");
      }
    },
  });
  const membership = (target: "whitelist" | "blacklist"): SubcommandDefinition => ({
    description: target === "whitelist" ? "管理白名单" : "管理黑名单", aliases: [target === "whitelist" ? "wl" : "bl"],
    subcommands: {
      list: {description: "查看聊天名单", args: "", async handle(i, ctx) {
        const data = await store(ctx).read(); await ctx.telegram.edit(i.message, `${target}: ${data[target].join(", ") || "空"}`);
      }},
      ...Object.fromEntries(["add", "remove"].map(action => [action, {
        description: action === "add" ? "添加当前会话" : "移除当前会话", args: "",
        async handle(i, ctx) {
          const chatId = i.message.chatId;
          await store(ctx).update(data => {
            const list = [...data[target]], index = list.indexOf(chatId);
            if (action === "add" && index < 0) list.push(chatId);
            if (action === "remove" && index >= 0) list.splice(index, 1);
            return {...data, [target]: list};
          });
          await ctx.telegram.edit(i.message, `${target === "whitelist" ? "白名单" : "黑名单"}已更新`);
        },
      } satisfies SubcommandDefinition])),
    }, handle: showHelp,
  });
  const command: CommandDefinition = {
    description: "格式化中英文间距", helpArgs: ["help", "h"], args: "[文本]", subcommandsCaseSensitive: false,
    examples: [{args: "", description: "查看当前状态"}, {args: "你好World2026", description: "手动格式化文本"}],
    subcommands: {
      on: toggle(true), off: toggle(false),
      reset: {description: "当前会话恢复跟随全局", args: "", async handle(i, ctx) {
        await store(ctx).update(data => { const chats = {...data.chats}; delete chats[i.message.chatId]; return {...data, chats}; });
        await ctx.telegram.edit(i.message, "当前会话已恢复跟随全局");
      }},
      global: {description: "设置全局格式化开关", aliases: ["g"], subcommands: {on: toggle(true, true), off: toggle(false, true)}, handle: showHelp},
      stats: {description: "查看格式化消息数量、启用会话和名单统计", aliases: ["stat"], args: "", async handle(invocation, ctx) {
      const db = store(ctx);
      const data = await db.read();
      await ctx.telegram.edit(invocation.message, `格式化消息: ${data.stats.formattedMessages}\n启用会话: ${Object.values(data.chats).filter(Boolean).length}\n全局模式: ${data.globalMode ? "开启" : "关闭"}\n白名单: ${data.whitelist.length}\n黑名单: ${data.blacklist.length}`, {parseMode:"html"}); return;

      }},
      whitelist: membership("whitelist"), blacklist: membership("blacklist"),
    },
    help: [{heading: "格式与范围：", body: "在 CJK 中文、字母、数字和符号之间添加间距，并保护 HTTP/HTTPS 链接。手动文本最多 16000 字符，保留多行；自动处理自己发出的消息及收藏夹消息，包括编辑消息，忽略命令。"},
      {heading: "优先级：", body: "白名单非空时，只有白名单中的聊天启用，名单命中即格式化；白名单为空时先排除黑名单，再使用会话开关，会话未设置时跟随全局。reset 恢复跟随全局；全局默认关闭。"}],
    async handle(invocation, ctx) {
      if (!invocation.args[0]) {
      const data = await store(ctx).read();
      const chat = data.chats[invocation.message.chatId];
      const active = data.whitelist.length ? data.whitelist.includes(invocation.message.chatId) :
        !data.blacklist.includes(invocation.message.chatId) && (chat ?? data.globalMode);
      await ctx.telegram.edit(invocation.message, `盘古之白\n当前生效: ${active ? "开启" : "关闭"}\n会话设置: ${chat === undefined ? "跟随全局" : chat ? "开启" : "关闭"}\n全局模式: ${data.globalMode ? "开启" : "关闭"}\n已格式化: ${data.stats.formattedMessages}`); return;

      }
    const args = invocation.args, sub = args[0]?.toLowerCase();
    const text = invocation.message.text?.replace(/^\S+\s*/, "") ?? args.join(" ");
    if (!text || sub === "help" || sub === "h") { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode:"html"}); return; }
    await format(ctx, invocation.message, text);

    },
  };
  const help = (prefix: string) => renderCommandHelp("pangu", command, {prefix, title: "📝 盘古之白"});
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "pangu", description: "格式化中英文间距",
    async setup(ctx) {
      const db = rawStore(ctx);
      if ((await db.read()).legacyImported) return;
      const legacy = await ctx.storage.json<Partial<Data>>("config.json", {}).read();
      if (!Object.keys(legacy).length) return;
      await db.update(current => current.legacyImported ? current : normalize({
        ...legacy, ...current,
        chats: {...legacy.chats, ...current.chats},
        stats: {...legacy.stats, ...current.stats} as Data["stats"],
        legacyImported: true,
      }));
    },
    listeners: [{
    direction: "outgoing", includeSaved: true,
    ignoreCommands: true,
    edited: true,
    handle: async (message, ctx) => {
      if (!message.text.trim()) return;
      const data = await store(ctx).read();
      if (data.whitelist.length > 0) {
        if (!data.whitelist.includes(message.chatId)) return;
      } else {
        if (data.blacklist.includes(message.chatId)) return;
        if (!(data.chats[message.chatId] ?? data.globalMode)) return;
      }
      const changed = spacing(message.text);
      if (changed === message.text) return;
      await ctx.telegram.edit(message, changed);
      await store(ctx).update(current => ({...current, stats: {...current.stats, formattedMessages: current.stats.formattedMessages + 1, lastFormatted: Date.now()}}));
    },
  }], commands: {
    pangu: command,
  }});
}
async function format(ctx: PluginContext, message: MessageEnvelope, text: string) {
  if (text.length > 16000) { await ctx.telegram.edit(message, "文本过长，最多支持 16000 字符"); return; }
  const pages: string[] = []; let page = "";
  for (const character of spacing(text)) {
    const escaped = character.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
    if (page.length + escaped.length > 3500) { pages.push(page); page = ""; }
    page += escaped;
  }
  if (page) pages.push(page);
  for (const [index, content] of pages.entries()) {
    ctx.signal.throwIfAborted();
    if (index === 0) await ctx.telegram.edit(message, content, {parseMode:"html"});
    else await ctx.telegram.reply(message, content, {parseMode:"html"});
  }
}
