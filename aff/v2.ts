import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";

type Entry = {text: string; webPage?: boolean; web_page?: boolean; created_at?: number};
type Data = {affs: Entry[]; aff?: Entry};
const help = `<b>Aff 信息</b>\n<code>aff</code> 发送信息\n<code>aff list [页码]</code> 查看列表\n<code>aff save</code> 回复消息保存\n<code>aff remove 1</code> 删除信息`;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
const store = (ctx: PluginContext) => ctx.storage.json<Data>("data.json", {affs: []});
async function output(ctx: PluginContext, message: MessageEnvelope, item: Entry) {
  // Legacy entries were sent as HTML; V2 entries store literal message text.
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
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "aff", description: "管理并发送 Aff 信息",
    async setup(ctx) {
      const db = store(ctx);
      if ((await db.read()).aff) await db.update(current => {
        if (!current.aff) return current;
        const {aff, ...rest} = current;
        return {...rest, affs: [...(current.affs ?? []), aff]};
      });
    },
    commands: {
    aff: {helpArgs: ["help","h"], description: "管理并发送 Aff 信息", async handle(invocation, ctx) {
      const db = store(ctx);
      const args = invocation.args;
      if (!args.length || args[0] === "help" || args[0] === "h") {
        if (!args.length) {
          const data = await db.read();
          if (data.affs.length === 1) return output(ctx, invocation.message, data.affs[0]);
          if (data.affs.length > 1) {
            return list(ctx, invocation.message, data.affs);
          }
        }
        await ctx.telegram.edit(invocation.message, help, {parseMode: "html"}); return;
      }
      const sub = args[0].toLowerCase();
      const data = await db.read();
      if (sub === "list") {
        return list(ctx, invocation.message, data.affs, args[1]);
      }
      if (sub === "save") {
        const reply = await ctx.telegram.getReply(invocation.message);
        if (!reply?.text.trim()) { await ctx.telegram.edit(invocation.message, "请回复要保存的消息"); return; }
        if (reply.text.length > 4000) {
          await ctx.telegram.edit(invocation.message, "文本超过 4000 字符，未保存，请缩短后重试"); return;
        }
        let full = false;
        await db.update(current => {
          if (current.affs.length >= 32) {full = true; return current;}
          return {...current, affs: [...current.affs, {text: reply.text, webPage: /https?:\/\/[^\s]+/.test(reply.text), created_at: Date.now()}]};
        });
        if (full) {
          await ctx.telegram.edit(invocation.message, "已保存 32 条，请先删除不需要的记录再保存"); return;
        }
        await ctx.telegram.edit(invocation.message, "Aff 信息已保存"); return;
      }
      if (["remove", "rm", "del"].includes(sub)) {
        const index = Number(args[1]) - 1;
        if (!/^[1-9]\d*$/.test(args[1] ?? "") || !Number.isSafeInteger(index)) { await ctx.telegram.edit(invocation.message, "序号无效"); return; }
        let removed = false;
        await db.update(current => {
          if (index >= current.affs.length) return current;
          removed = true;
          return {...current, affs: current.affs.filter((_, i) => i !== index)};
        });
        await ctx.telegram.edit(invocation.message, removed ? "Aff 信息已删除" : "序号无效"); return;
      }
      const index = Number(sub) - 1;
      if (Number.isInteger(index) && data.affs[index]) return output(ctx, invocation.message, data.affs[index]);
      await ctx.telegram.edit(invocation.message, help, {parseMode: "html"});
    }},
  }});
}
