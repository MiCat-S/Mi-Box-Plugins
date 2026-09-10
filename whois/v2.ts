import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin, type PluginContext} from "telebox/sdk";
import {report} from "./v2/report";
import {records, type WhoisRecords} from "./v2/records";


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
const command: CommandDefinition = {
  description: "查询域名注册信息", helpArgs: ["help", "h"], args: "[域名]", subcommandsCaseSensitive: false,
  examples: [{args: "google.com"}, {args: "https://example.com/path"}, {args: "", description: "回复含域名的消息查询"}],
  subcommands: {
    clear: {description: "清空查询历史与缓存", args: "", async handle(invocation, ctx) {
      const db = records(ctx);
        const counts = await db.clear();
        await ctx.telegram.edit(invocation.message, `已清除历史 ${counts.history} 条、缓存 ${counts.cache} 个域名`); return;
          }},
    history: {description: "查看查询历史及缓存数量", args: "", async handle(invocation, ctx) {
      const db = records(ctx);
        const data = await db.history();
        const rows = data.rows.map((item, i) => `${i + 1}. <code>${esc(item.domain)}</code> <i>${item.queryTime.slice(5, 16).replace("T", " ")}</i>`).join("\n");
        await ctx.telegram.edit(invocation.message, `<b>WHOIS 查询历史</b>\n\n${rows || "暂无查询历史"}\n\n共 ${data.history} 条，缓存 ${data.cache} 个`, {parseMode:"html"}); return;
          }},
    batch: {description: "批量查询并显示各域名是否成功", args: "域名1 [域名2...]", examples: [{args: "batch google.com github.com"}], help: [{body: "最多 10 个域名；批量结果为成功/失败摘要，详细记录可通过单域名查询读取。"}], async handle(invocation, ctx) {
      const inputs = invocation.args, db = records(ctx);
        if (!inputs.length) { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode:"html"}); return; }
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
          }},
  },
  help: [{heading: "数据与显示：", body: "通过 namebeta.com 查询 WHOIS，显示注册商、DNS、状态和注册/更新/到期日期，并在报告中提示临近到期。支持从 URL 或回复消息提取域名；查询结果默认缓存 24 小时，详细报告自动分段。"}],
  async handle(invocation, ctx) {
    let raw = invocation.args[0] ?? "";
    if (raw.toLowerCase() === "help" || raw.toLowerCase() === "h") { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    if (!raw) {
      const reply = await ctx.telegram.getReply(invocation.message);
      raw = reply?.text.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s]*)?/i)?.[0] ?? "";
      if (!raw) { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    }
      const db = records(ctx);
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
  },
};
const help = (prefix: string) => renderCommandHelp("whois", command, {prefix, title: "🔍 WHOIS 域名查询"});
export default function createWhois() {
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "whois", description: "查询域名注册信息",
    async setup(ctx) { await records(ctx).initialize(); }, commands: {whois: command},
  });
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
