import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext} from "telebox/sdk";
type Mode = "off" | "del" | "bold" | "italic" | "underline" | "mask" | "all";
type Data = {chats: Record<string, Mode>; whitelist: string[]; blacklist: string[]; globalMode: Mode};
const help = `<b>消息模式</b>\n<code>mode bold|italic|underline|del|mask|all|off</code>\n<code>mode global bold</code>\n<code>mode whitelist add|remove|list</code>\n<code>mode blacklist add|remove|list</code>`;
const modes = new Set<Mode>(["off", "del", "bold", "italic", "underline", "mask", "all"]);
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
export default function createMode() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "mode", description: "管理消息格式模式",
    listeners: [{ignoreCommands: true, async handle(message, ctx) {
      if (!(message.outgoing || message.saved) || !message.text.trim()) return;
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
    }}], commands: {
    mode: {helpArgs: ["help","h"], description: "管理消息格式模式", async handle(invocation, ctx: PluginContext) {
      const db = ctx.storage.json<Data>("config.json", {chats: {}, whitelist: [], blacklist: [], globalMode: "off"});
      const data = await db.read(); const chat = invocation.message.chatId; const [first, second] = invocation.args.map(String);
      if (!first) {
        await ctx.telegram.edit(invocation.message, `<b>消息模式</b>\n当前会话: ${esc(data.chats[chat] ?? "off")}\n全局模式: ${esc(data.globalMode)}`, {parseMode:"html"}); return;
      }
      if (first === "help" || first === "h") { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
      if (first === "global") {
        if (!second) { await ctx.telegram.edit(invocation.message, `<b>全局模式:</b> ${esc(data.globalMode)}`, {parseMode:"html"}); return; }
        if (!modes.has(second as Mode)) { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
        await db.update(current => ({...current, globalMode: second as Mode}));
        await ctx.telegram.edit(invocation.message, `全局模式已设置为 ${esc(second)}`, {parseMode:"html"}); return;
      }
      if (first === "whitelist" || first === "blacklist") {
        const list = first === "whitelist" ? data.whitelist : data.blacklist;
        if (second === "list") { await ctx.telegram.edit(invocation.message, list.length ? list.map((id, i) => `${i + 1}. <code>${esc(id)}</code>`).join("\n") : "列表为空", {parseMode:"html"}); return; }
        if (!["add", "remove", "rm"].includes(second)) { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
        await db.update(current => ({
          ...current,
          [first]: second === "add" ? [...new Set([...current[first], chat])] : current[first].filter(id => id !== chat),
        }));
        await ctx.telegram.edit(invocation.message, "设置已更新"); return;
      }
      if (!modes.has(first as Mode)) { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
      await db.update(current => ({...current, chats: {...current.chats, [chat]: first as Mode}}));
      await ctx.telegram.edit(invocation.message, `当前会话模式已设置为 ${esc(first)}`);
    }},
  }});
}
