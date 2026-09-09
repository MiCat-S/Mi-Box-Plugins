import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext} from "telebox/sdk";
import {report} from "./v2/report";
import {records, type WhoisRecords} from "./v2/records";

const help = `<b>WHOIS 域名查询</b>\n<code>whois example.com</code>`;
const positive = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
function domain(raw: string): string | undefined {
  const value = raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z]{2,})+$/.test(value) && value.length <= 253 ? value.toLowerCase() : undefined;
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
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "whois", description: "查询域名注册信息",
    async setup(ctx) { await records(ctx).initialize(); },
    commands: {
    whois: {helpArgs: ["help","h"], description: "查询域名注册信息", async handle(invocation, ctx) {
      let raw = invocation.args[0] ?? "";
      if (raw.toLowerCase() === "help" || raw.toLowerCase() === "h") { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
      if (!raw) {
        const reply = await ctx.telegram.getReply(invocation.message);
        raw = reply?.text.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s]*)?/i)?.[0] ?? "";
        if (!raw) {await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return;}
      }
      const db = records(ctx);
      if (raw.toLowerCase() === "clear") {
        const counts = await db.clear();
        await ctx.telegram.edit(invocation.message, `已清除历史 ${counts.history} 条、缓存 ${counts.cache} 个域名`); return;
      }
      if (raw.toLowerCase() === "history") {
        const data = await db.history();
        const rows = data.rows.map((item, i) => `${i + 1}. <code>${esc(item.domain)}</code> <i>${item.queryTime.slice(5, 16).replace("T", " ")}</i>`).join("\n");
        await ctx.telegram.edit(invocation.message, `<b>WHOIS 查询历史</b>\n\n${rows || "暂无查询历史"}\n\n共 ${data.history} 条，缓存 ${data.cache} 个`, {parseMode:"html"}); return;
      }
      const inputs = raw.toLowerCase() === "batch" ? invocation.args.slice(1) : invocation.args.slice(0, 10);
      if (raw.toLowerCase() === "batch") {
        if (!inputs.length) { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
        if (inputs.length > 10) { await ctx.telegram.edit(invocation.message, "批量查询最多支持 10 个域名"); return; }
        const results: string[] = [];
        for (const input of inputs) {
          ctx.signal.throwIfAborted();
          const name = domain(input);
          if (!name) { results.push(`❌ ${esc(input)}：格式无效`); continue; }
          const result = await query(name, ctx, db);
          results.push(result ? `✅ <code>${esc(name)}</code>` : `❌ <code>${esc(name)}</code>：查询失败`);
        }
        await ctx.telegram.edit(invocation.message, `<b>WHOIS 批量查询</b>\n\n${results.join("\n")}`, {parseMode:"html"}); return;
      }
      const name = domain(raw);
      if (!name) { await ctx.telegram.edit(invocation.message, "请输入有效域名，例如 <code>example.com</code>", {parseMode:"html"}); return; }
      try {
        await ctx.telegram.edit(invocation.message, `🔍 正在查询 <code>${esc(name)}</code>…`, {parseMode:"html"});
        const result = await query(name, ctx, db);
        if (!result) { await ctx.telegram.edit(invocation.message, "未取得 WHOIS 数据"); return; }
        for (const [index, page] of report(name, result).entries()) {
          ctx.signal.throwIfAborted();
          if (index === 0) await ctx.telegram.edit(invocation.message, page, {parseMode: "html", linkPreview: false});
          else await ctx.telegram.reply(invocation.message, page, {parseMode: "html", linkPreview: false});
        }
      } catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "WHOIS 查询失败，请稍后重试"); }
    }},
  }});
}

async function query(name: string, ctx: PluginContext, db: WhoisRecords): Promise<string> {
  ctx.signal.throwIfAborted();
  const {cached, settings} = await db.lookup(name);
  const age = cached ? Date.now() - Date.parse(cached.queryTime) : NaN;
  if (cached && age >= 0 && age < positive(settings?.cacheHours, 24) * 3600000) return cached.rawData;
  try {
    const text = await ctx.http.text(`https://namebeta.com/api/search/check?query=${encodeURIComponent(name)}`, {headers: {"user-agent": "Mi Box"}}, {timeoutMs: 10000, redirects:{allowedHosts:["namebeta.com"],maxRedirects:2}});
    const result = extract(text);
    if (!result) return "";
    const item = {domain: name, rawData: result, queryTime: new Date().toISOString()};
    await db.save(item);
    return result;
  } catch { ctx.signal.throwIfAborted(); return ""; }
}
