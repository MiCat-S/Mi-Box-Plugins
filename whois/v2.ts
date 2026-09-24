import { renderHelp as renderPluginHelp } from "./v2/help";
import { definePlugin, ui, type MessageEnvelope, type PluginContext } from "telebox/sdk";
import { report } from "./v2/report";
import { records, type WhoisRecords } from "./v2/records";

const positive = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function domain(raw: string): string | undefined {
  const value = raw
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0];
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z]{2,})+$/.test(value) && value.length <= 253
    ? value.toLowerCase()
    : undefined;
}
function extract(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.trim().slice(5).trim());
      const text = event?.data?.whois?.whois;
      if (typeof text === "string") return text;
    } catch {}
  }
  return "";
}
export default function createWhois() {
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "whois",
    description: "查询域名注册信息",
    async setup(ctx) {
      await records(ctx).initialize();
    },
    commands: {
      whois: {
        helpArgs: ["help", "h"],
        description: "查询域名注册信息",
        async handle(invocation, ctx) {
          let raw = invocation.args[0] ?? "";
          if (raw.toLowerCase() === "help" || raw.toLowerCase() === "h") {
            await ctx.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), {
              parseMode: "html",
              linkPreview: false,
            });
            return;
          }
          if (!raw || !["batch", "history", "clear"].includes(raw.toLowerCase())) {
            const reply = await ctx.telegram.getReply(invocation.message);
            raw =
              reply?.text.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s]*)?/i)?.[0] ?? raw;
            if (!raw) {
              await ctx.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), {
                parseMode: "html",
                linkPreview: false,
              });
              return;
            }
          }
          const db = records(ctx);
          if (raw.toLowerCase() === "clear") {
            let counts: Awaited<ReturnType<typeof db.clear>>;
            try {
              counts = await db.clear();
            } catch {
              if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "WHOIS 记录清除失败，请稍后重试");
              return;
            }
            try {
              await ctx.telegram.edit(
                invocation.message,
                `已清除历史 ${counts.history} 条、缓存 ${counts.cache} 个域名`,
              );
            } catch {
              if (!ctx.signal.aborted) ctx.log.error("whois:receipt-failed");
            }
            return;
          }
          if (raw.toLowerCase() === "history") {
            try {
              const data = await db.history();
              const rows = data.rows.map((item, i) =>
                ui.concat(
                  ui.text(`${i + 1}. `),
                  ui.code(item.domain),
                  ui.text(` ${item.queryTime.slice(5, 16).replace("T", " ")}`),
                ),
              );
              await deliver(
                ctx,
                invocation.message,
                await ui.renderDocument({
                  title: "WHOIS 查询历史",
                  sections: [ui.section(rows.length ? rows : [ui.text("暂无查询历史")])],
                  footer: `共 ${data.history} 条，缓存 ${data.cache} 个`,
                }),
              );
            } catch {
              if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "WHOIS 历史读取失败，请稍后重试");
            }
            return;
          }
          const inputs = raw.toLowerCase() === "batch" ? invocation.args.slice(1) : invocation.args.slice(0, 10);
          if (raw.toLowerCase() === "batch") {
            if (!inputs.length) {
              await ctx.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), {
                parseMode: "html",
                linkPreview: false,
              });
              return;
            }
            if (inputs.length > 10) {
              await ctx.telegram.edit(invocation.message, "批量查询最多支持 10 个域名");
              return;
            }
            const results: string[] = [];
            for (const input of inputs) {
              ctx.signal.throwIfAborted();
              const name = domain(input);
              if (!name) {
                results.push(`❌ ${esc(input)}：格式无效`);
                continue;
              }
              const result = await query(name, ctx, db);
              results.push(result ? `✅ <code>${esc(name)}</code>` : `❌ <code>${esc(name)}</code>：查询失败`);
            }
            await ctx.telegram.edit(invocation.message, `<b>WHOIS 批量查询</b>\n\n${results.join("\n")}`, {
              parseMode: "html",
            });
            return;
          }
          const name = domain(raw);
          if (!name) {
            await ctx.telegram.edit(invocation.message, "请输入有效域名，例如 <code>example.com</code>", {
              parseMode: "html",
            });
            return;
          }
          try {
            await ctx.telegram.edit(invocation.message, `🔍 正在查询 <code>${esc(name)}</code>…`, {
              parseMode: "html",
            });
            const result = await query(name, ctx, db);
            if (!result) {
              await ctx.telegram.edit(invocation.message, "未取得 WHOIS 数据");
              return;
            }
            await deliver(ctx, invocation.message, report(name, result));
          } catch {
            if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "WHOIS 查询失败，请稍后重试");
          }
        },
      },
    },
  });
}

async function deliver(ctx: PluginContext, message: MessageEnvelope, pages: readonly string[]): Promise<void> {
  const result = await ui.deliverPages(pages, ctx.signal, async (page, index) => {
    if (!index) await ctx.telegram.edit(message, page, { parseMode: "html", linkPreview: false });
    else await ctx.telegram.reply(message, page, { parseMode: "html", linkPreview: false });
  });
  if (!result.interrupted) return;
  ctx.log.error("whois:output-failed");
  if (!result.published) throw new Error("delivery failed");
  try {
    await ctx.telegram.reply(message, ui.interruptedNotice(result));
  } catch {
    if (!ctx.signal.aborted) ctx.log.error("whois:output-notice-failed");
  }
}

async function query(name: string, ctx: PluginContext, db: WhoisRecords): Promise<string> {
  ctx.signal.throwIfAborted();
  const { cached, settings } = await db.lookup(name);
  const age = cached ? Date.now() - Date.parse(cached.queryTime) : NaN;
  if (cached && age >= 0 && age < positive(settings?.cacheHours, 24) * 3600000) return cached.rawData;
  try {
    const text = await ctx.http.text(
      `https://namebeta.com/api/search/check?query=${encodeURIComponent(name)}`,
      { headers: { "user-agent": "Mi Box" } },
      { timeoutMs: 10000, redirects: { allowedHosts: ["namebeta.com"], maxRedirects: 2 } },
    );
    const result = extract(text);
    if (!result) return "";
    const item = { domain: name, rawData: result, queryTime: new Date().toISOString() };
    await db.save(item);
    return result;
  } catch {
    ctx.signal.throwIfAborted();
    return "";
  }
}
