import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext, type CommandInvocation, type MessageEnvelope} from "telebox/sdk";
const help = `<b>盘古之白</b>\n<code>pangu</code> 当前状态\n<code>pangu 文本</code> 格式化中英文间距\n<code>pangu on/off</code> 当前会话开关\n<code>pangu reset</code> 当前会话恢复跟随全局\n<code>pangu global on/off</code> 全局开关\n<code>pangu whitelist add/remove/list</code> 白名单\n<code>pangu blacklist add/remove/list</code> 黑名单\n<code>pangu stats</code> 统计`;
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
  const command = async (invocation: CommandInvocation, ctx: PluginContext) => {
    const args = invocation.args;
    const sub = args[0]?.toLowerCase();
    if (!sub) {
      const data = await store(ctx).read();
      const chat = data.chats[invocation.message.chatId];
      const active = data.whitelist.length ? data.whitelist.includes(invocation.message.chatId) :
        !data.blacklist.includes(invocation.message.chatId) && (chat ?? data.globalMode);
      await ctx.telegram.edit(invocation.message, `盘古之白\n当前生效: ${active ? "开启" : "关闭"}\n会话设置: ${chat === undefined ? "跟随全局" : chat ? "开启" : "关闭"}\n全局模式: ${data.globalMode ? "开启" : "关闭"}\n已格式化: ${data.stats.formattedMessages}`); return;
    }
    if (sub === "reset") {
      await store(ctx).update(data => {
        const chats = {...data.chats}; delete chats[invocation.message.chatId];
        return {...data, chats};
      });
      await ctx.telegram.edit(invocation.message, "当前会话已恢复跟随全局"); return;
    }
    if (["on", "off", "enable", "disable", "true", "false"].includes(sub)) {
      const db = store(ctx);
      const enabled = ["on", "enable", "true"].includes(sub);
      await db.update(data => ({...data, chats: {...data.chats, [invocation.message.chatId]: enabled}}));
      await ctx.telegram.edit(invocation.message, enabled ? "当前会话已开启自动格式化" : "当前会话已关闭自动格式化"); return;
    }
    if (sub === "global" || sub === "g") {
      const db = store(ctx);
      const value = args[1]?.toLowerCase();
      if (value !== "on" && value !== "off") { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
      await db.update(data => ({...data, globalMode: value === "on"}));
      await ctx.telegram.edit(invocation.message, `全局格式化已${value === "on" ? "开启" : "关闭"}`); return;
    }
    if (sub === "stats" || sub === "stat") {
      const db = store(ctx);
      const data = await db.read();
      await ctx.telegram.edit(invocation.message, `格式化消息: ${data.stats.formattedMessages}\n启用会话: ${Object.values(data.chats).filter(Boolean).length}\n全局模式: ${data.globalMode ? "开启" : "关闭"}\n白名单: ${data.whitelist.length}\n黑名单: ${data.blacklist.length}`, {parseMode:"html"}); return;
    }
    if (sub === "whitelist" || sub === "wl" || sub === "blacklist" || sub === "bl") {
      const db = store(ctx);
      const target = sub.startsWith("white") || sub === "wl" ? "whitelist" : "blacklist";
      const action = args[1]?.toLowerCase();
      if (!["add", "remove", "list"].includes(action)) { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
      if (action === "list") { const data = await db.read(); await ctx.telegram.edit(invocation.message, `${target}: ${(data[target] as string[]).join(", ") || "空"}`); return; }
      const chatId = invocation.message.chatId;
      await db.update(data => {
        const list = [...data[target]];
        const index = list.indexOf(chatId);
        if (action === "add" && index < 0) list.push(chatId);
        if (action === "remove" && index >= 0) list.splice(index, 1);
        return {...data, [target]: list};
      });
      await ctx.telegram.edit(invocation.message, `${target === "whitelist" ? "白名单" : "黑名单"}已更新`); return;
    }
    const text = invocation.message.text?.replace(/^\S+\s*/, "") ?? args.join(" ");
    if (!text || sub === "help" || sub === "h") { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
    await format(ctx, invocation.message, text);
  };
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "pangu", description: "格式化中英文间距",
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
    ignoreCommands: true,
    edited: true,
    handle: async (message, ctx) => {
      if (!message.text.trim() || !(message.outgoing || message.saved)) return;
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
    pangu: {helpArgs: ["help","h"], description: "格式化中英文间距", handle: command},
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
