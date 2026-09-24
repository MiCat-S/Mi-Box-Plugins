import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, type MessageEnvelope, type PluginContext } from "telebox/sdk";

type Entry = { text: string; webPage?: boolean; web_page?: boolean; format?: "html"; created_at?: number };
type Data = { affs: Entry[]; aff?: Entry };
const esc = (s: string) =>
  String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const store = (ctx: PluginContext) => ctx.storage.json<Data>("data.json", { affs: [] });

/**
 * Explicit `format: "html"` marks entries saved by this version. Original-plugin
 * entries carry `web_page` and were always sent as HTML; V2-era `webPage`-only
 * entries keep their historical literal semantics and are never reinterpreted.
 */
async function output(ctx: PluginContext, message: MessageEnvelope, item: Entry) {
  const html = item.format === "html" || item.web_page !== undefined;
  await ctx.telegram.edit(message, item.text, {
    parseMode: html ? "html" : undefined,
    linkPreview: !(item.webPage ?? item.web_page ?? false),
  });
}

async function list(ctx: PluginContext, message: MessageEnvelope, entries: Entry[], pageArg = "1", prefix = ".") {
  if (entries.length === 0) {
    await ctx.telegram.edit(message, "📂 <b>Aff列表为空</b>", { parseMode: "html", linkPreview: false });
    return;
  }
  const count = Math.max(1, Math.ceil(entries.length / 10));
  const page = Number(pageArg);
  if (!/^[1-9]\d*$/.test(pageArg) || !Number.isSafeInteger(page) || page > count) {
    await ctx.telegram.edit(message, `页码无效，共 ${count} 页`);
    return;
  }
  const text = entries
    .slice((page - 1) * 10, page * 10)
    .map((item, i) => {
      const chars = Array.from(item.text.replace(/\s+/g, " "));
      return `${(page - 1) * 10 + i + 1}. ${esc(chars.slice(0, 30).join(""))}${chars.length > 30 ? "..." : ""}`;
    })
    .join("\n");
  const tail = `\n\n💡 使用 <code>${esc(prefix)}aff &lt;序号&gt;</code> 发送指定条目`;
  await ctx.telegram.edit(message, `<b>Aff 列表</b> · ${page}/${count}\n\n${text}${tail}`, {
    parseMode: "html",
    linkPreview: false,
  });
}

export default function createAff() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "aff",
    description: "管理并发送 Aff 信息",
    async setup(ctx) {
      const db = store(ctx);
      if ((await db.read()).aff)
        await db.update(current => {
          if (!current.aff) return current;
          const { aff, ...rest } = current;
          return { ...rest, affs: [...(current.affs ?? []), aff] };
        });
    },
    commands: {
      aff: {
        helpArgs: ["help", "h"],
        description: "管理并发送 Aff 信息",
        async handle(invocation, ctx) {
          const db = store(ctx);
          const message = invocation.message;
          const prefix = invocation.prefix;
          const args = invocation.args;

          if (!args.length || args[0] === "help" || args[0] === "h") {
            if (!args.length) {
              const data = await db.read();
              if (data.affs.length === 0) {
                await ctx.telegram.edit(
                  message,
                  `❌ <b>暂无Aff信息</b>\n\n💡 请回复一条消息使用 <code>${esc(prefix)}aff save</code> 保存`,
                  { parseMode: "html" },
                );
                return;
              }
              if (data.affs.length === 1) return output(ctx, message, data.affs[0]);
              return list(ctx, message, data.affs, "1", prefix);
            }
            await ctx.telegram.edit(message, renderPluginHelp(prefix), { parseMode: "html" });
            return;
          }

          const sub = args[0].toLowerCase();
          const data = await db.read();

          if (sub === "list") return list(ctx, message, data.affs, args[1], prefix);

          if (sub === "save") {
            const reply = await ctx.telegram.getReply(message);
            const raw = reply?.raw as { message?: string } | undefined;
            const text = String(reply?.text || raw?.message || "");
            if (!reply || !text.trim()) {
              await ctx.telegram.edit(message, "❌ <b>请回复一条消息以保存新的Aff信息</b>", { parseMode: "html" });
              return;
            }
            if (text.length > 4000) {
              await ctx.telegram.edit(message, "❌ <b>文本超过 4000 字符，未保存，请缩短后重试</b>", {
                parseMode: "html",
              });
              return;
            }
            let index = -1;
            let full = false;
            await db.update(current => {
              if (current.affs.length >= 32) {
                full = true;
                return current;
              }
              index = current.affs.length + 1;
              return {
                ...current,
                affs: [
                  ...current.affs,
                  { text, webPage: /https?:\/\/[^\s]+/.test(text), format: "html", created_at: Date.now() },
                ],
              };
            });
            if (full) {
              await ctx.telegram.edit(message, "❌ <b>已保存 32 条，请先删除不需要的记录再保存</b>", {
                parseMode: "html",
              });
              return;
            }
            await ctx.telegram.edit(message, `✅ <b>Aff信息保存成功！</b>\n🆔 当前序号：${index}`, {
              parseMode: "html",
            });
            return;
          }

          if (["remove", "rm", "del"].includes(sub)) {
            const raw = args[1];
            if (!raw) {
              await ctx.telegram.edit(
                message,
                `❌ <b>请指定要删除的序号</b>\n💡 例如：<code>${esc(prefix)}aff remove 1</code>`,
                { parseMode: "html" },
              );
              return;
            }
            if (!/^[1-9]\d*$/.test(raw)) {
              await ctx.telegram.edit(message, "❌ <b>无效的序号</b>", { parseMode: "html" });
              return;
            }
            const target = Number(raw) - 1;
            let removed = false;
            await db.update(current => {
              if (target < 0 || target >= current.affs.length) return current;
              removed = true;
              return { ...current, affs: current.affs.filter((_, i) => i !== target) };
            });
            if (removed)
              await ctx.telegram.edit(message, `✅ <b>已删除序号 ${Number(raw)} 的Aff信息</b>`, { parseMode: "html" });
            else
              await ctx.telegram.edit(message, `❌ <b>删除失败：找不到序号 ${Number(raw)}</b>`, { parseMode: "html" });
            return;
          }

          if (/^-?\d+$/.test(sub)) {
            const real = Number(sub) - 1;
            if (Number.isSafeInteger(real) && real >= 0 && real < data.affs.length)
              return output(ctx, message, data.affs[real]);
            await ctx.telegram.edit(message, `❌ <b>找不到序号为 ${esc(sub)} 的Aff信息</b>`, { parseMode: "html" });
            return;
          }

          await ctx.telegram.edit(message, `❌ <b>无效的参数</b>\n\n${renderPluginHelp(prefix)}`, {
            parseMode: "html",
          });
        },
      },
    },
  });
}
