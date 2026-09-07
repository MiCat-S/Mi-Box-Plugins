import {definePlugin, type PluginContext} from "telebox/sdk";
const help = `<b>BIN 查询</b>\n<code>bin 415042</code> 查询银行卡前六至八位信息`;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
const field = (value: unknown) => typeof value === "string" && value ? value : "未知";
const schemeName = (value: unknown) => {
  const name = typeof value === "string" ? value.toLowerCase() : "";
  return ({amex: "American Express", mastercard: "Master Card", unionpay: "UnionPay"} as Record<string, string>)[name] ??
    (name ? name[0].toUpperCase() + name.slice(1) : "未知");
};
const types: Record<string, string> = {credit: "贷记", debit: "借记", charge: "签账", prepaid: "预付"};
const currencies: Record<string, string> = {USD: "美元", TWD: "新台币", CNY: "人民币", HKD: "港币", EUR: "欧元", JPY: "日元", GBP: "英镑"};
async function bincheck(ctx: PluginContext, bin: string) {
  try {
    const html = await ctx.http.withResponse(`https://bincheck.io/details/${bin.slice(0, 6)}`,
      {headers: {"user-agent": "Mi Box"}}, async response => {
        if (response.status !== 200) throw new Error("bincheck");
        return response.text();
      }, {timeoutMs: 8000, redirects:{allowedHosts:["bincheck.io"],maxRedirects:2}});
    const description = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? "";
    const match = description.match(/valid BIN number\s+\d+\s+(?:is\s+)?(?:a\s+)?valid BIN number\s+([A-Z ]+)\s+issued by\s+(.+?)\s+in\s+(.+)/i) ??
      description.match(/valid BIN number\s+([A-Z ]+)\s+issued by\s+(.+?)\s+in\s+(.+)/i);
    return match ? {scheme: match[1].trim().toLowerCase().replace(/\s+/g, ""), bank: match[2].trim(), country: match[3].trim()} : {};
  } catch { return {}; }
}
export default function createBin() {
  return definePlugin({apiVersion: 1, id: "bin", description: "查询银行卡 BIN 信息", commands: {
    bin: {description: "查询银行卡 BIN 信息", async handle(invocation, ctx: PluginContext) {
      const value = invocation.args[0] ?? "";
      if (!value || value === "help" || value === "h") { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
      if (!/^\d{6,8}$/.test(value)) { await ctx.telegram.edit(invocation.message, "请输入 6 至 8 位数字 BIN"); return; }
      try {
        await ctx.telegram.edit(invocation.message, "正在查询 BIN…");
        const [data, checked] = await Promise.all([
          ctx.http.json<any>(`https://lookup.binlist.net/${value}`, {"headers": {"accept": "application/json", "user-agent": "Mi Box"}}, {timeoutMs: 10000, redirects:{allowedHosts:["lookup.binlist.net"],maxRedirects:2}}),
          bincheck(ctx, value),
        ]);
        const brand = field(data?.brand);
        const countryName = (checked.country || data?.country?.name || "未知").replace(" (Province of China)", "").replace("Taiwan, Province of China", "Taiwan");
        const level = brand.toUpperCase().match(/BUSINESS|CORPORATE|PLATINUM|GOLD|CLASSIC|SIGNATURE|INFINITE|WORLD|PREMIUM/)?.[0] ?? "—";
        const text = `<b>BIN 查询结果</b>\n\n<b>卡头:</b> <code>${value}</code>\n<b>卡组织:</b> ${esc(schemeName(checked.scheme || data?.scheme))}\n<b>类型:</b> ${esc(types[String(data?.type).toLowerCase()] ?? field(data?.type))}\n<b>品牌:</b> ${esc(brand)}\n<b>等级:</b> ${esc(level)}\n<b>卡号:</b> ${esc(Number.isFinite(data?.number?.length) ? `${data.number.length} 位` : "未知")} | Luhn: ${typeof data?.number?.luhn === "boolean" ? (data.number.luhn ? "是" : "否") : "未知"}\n<b>银行:</b> ${esc(checked.bank || field(data?.bank?.name))}\n<b>国家:</b> ${esc([data?.country?.emoji, countryName, data?.country?.alpha2].filter(Boolean).join(" ") || "未知")}\n<b>货币:</b> ${esc(currencies[data?.country?.currency] ?? field(data?.country?.currency))}\n<b>预付卡:</b> ${data?.prepaid === true ? "是" : "否"}\n<b>商业卡:</b> ${/BUSINESS|CORPORATE|COMMERCIAL/i.test(brand) ? "是" : "否"}`;
        await ctx.telegram.edit(invocation.message, text, {parseMode:"html"});
      } catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "BIN 查询失败，请稍后重试"); }
    }},
  }});
}
