import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, ui, type PluginContext} from "telebox/sdk";
import {countries, continents} from "./v2/countries";
const help = `<b>BIN 查询</b>\n<code>bin 415042</code> 查询银行卡前六至八位信息`;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
const field = (value: unknown) => typeof value === "string" && value ? value : "未知";
const schemeName = (value: unknown) => {
  const name = typeof value === "string" ? value.toLowerCase() : "";
  return ({amex: "AMERICAN EXPRESS", mastercard: "MASTERCARD", unionpay: "UNIONPAY"} as Record<string, string>)[name] ??
    (name ? name.toUpperCase() : "未知");
};
const types: Record<string, string> = {credit: "贷记", debit: "借记", charge: "签账", prepaid: "预付"};
const yesNo = (value: unknown) => typeof value === "boolean" ? (value ? "是" : "否") : "未知";
const currencyName = (code: string) => {
  if (!/^[A-Z]{3}$/.test(code)) return "未知";
  const name = new Intl.DisplayNames(["en"], {type: "currency"}).of(code) ?? code;
  const symbol = new Intl.NumberFormat("en", {style: "currency", currency: code, currencyDisplay: "narrowSymbol"})
    .formatToParts(0).find(part => part.type === "currency")?.value;
  return `${code}${symbol && symbol !== code ? ` ${symbol}` : ""} · ${name}`;
};
interface Rates {at: number; updated: string; rates: Record<string, number>;}
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
  let cachedRates: Rates | undefined;
  let pendingRates: Promise<Rates | undefined> | undefined;
  async function exchange(ctx: PluginContext): Promise<Rates | undefined> {
    if (cachedRates && Date.now() - cachedRates.at < 60 * 60 * 1000) return cachedRates;
    if (pendingRates) return pendingRates;
    pendingRates = (async () => {
      try {
        const data = await ctx.http.json<any>("https://open.er-api.com/v6/latest/USD", {},
          {timeoutMs: 5000, redirects: {allowedHosts: ["open.er-api.com"], maxRedirects: 1}});
        if (data?.result !== "success" || data.base_code !== "USD" || !data.rates || typeof data.rates !== "object") return;
        const rates: Record<string, number> = Object.create(null);
        for (const [code, value] of Object.entries(data.rates)) {
          if (/^[A-Z]{3}$/.test(code) && typeof value === "number" && Number.isFinite(value) && value > 0) rates[code] = value;
        }
        if (!rates.CNY) return;
        const time = new Date(data.time_last_update_unix * 1000);
        cachedRates = {at: Date.now(), updated: Number.isFinite(time.getTime()) ? time.toISOString().slice(0, 10) : "", rates};
        return cachedRates;
      } catch { ctx.signal.throwIfAborted(); return undefined; }
      finally { pendingRates = undefined; }
    })();
    return pendingRates;
  }
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "bin", description: "查询银行卡 BIN 信息", commands: {
    bin: {helpArgs: ["help","h"], helpOnEmpty: true, description: "查询银行卡 BIN 信息", async handle(invocation, ctx: PluginContext) {
      const value = invocation.args[0] ?? "";
      if (!value || value === "help" || value === "h") { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
      if (!/^\d{6,8}$/.test(value)) { await ctx.telegram.edit(invocation.message, "请输入 6 至 8 位数字 BIN"); return; }
      try {
        await ctx.telegram.edit(invocation.message, "正在查询 BIN…");
        const [data, checked, rates] = await Promise.all([
          ctx.http.json<any>(`https://lookup.binlist.net/${value}`, {"headers": {"accept": "application/json", "user-agent": "Mi Box"}}, {timeoutMs: 10000, redirects:{allowedHosts:["lookup.binlist.net"],maxRedirects:2}}),
          bincheck(ctx, value),
          exchange(ctx),
        ]);
        const brand = field(data?.brand);
        const countryName = (data?.country?.name || checked.country || "未知").replace(" (Province of China)", "").replace("Taiwan, Province of China", "Taiwan");
        const level = brand.toUpperCase().match(/WORLD ELITE|BUSINESS|CORPORATE|PLATINUM|GOLD|CLASSIC|SIGNATURE|INFINITE|WORLD|PREMIUM/)?.[0] ?? "未知";
        const countryCode = typeof data?.country?.alpha2 === "string" ? data.country.alpha2.toUpperCase() : "";
        const country = countries[countryCode];
        const flag = /^[A-Z]{2}$/.test(countryCode) ? [...countryCode].map(char => String.fromCodePoint(127397 + char.charCodeAt(0))).join("") : "";
        const currency = typeof data?.country?.currency === "string" ? data.country.currency.toUpperCase() : "";
        const business = typeof data?.commercial === "boolean" ? data.commercial : /BUSINESS|CORPORATE|COMMERCIAL/i.test(brand) ? true : undefined;
        const type = field(data?.type).toUpperCase();
        const numberDetails = [
          ...(Number.isSafeInteger(data?.number?.length) && data.number.length > 0 ? [`卡号长度  ${data.number.length} 位`] : []),
          ...(typeof data?.number?.luhn === "boolean" ? [`Luhn ${yesNo(data.number.luhn)}`] : []),
        ];
        const quote = (rate: number) => rate.toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: rate < 0.01 ? 6 : 4, useGrouping: false});
        const lines = [
          `<b>💳 BIN · 卡片档案</b>`,
          `卡头  <code>${value}</code>`,
          ``,
          `<b>${esc(schemeName(checked.scheme || data?.scheme))} · ${esc(type)}${types[type.toLowerCase()] ? `（${types[type.toLowerCase()]}）` : ""}</b>`,
          `级别  ${esc(level)}`,
          ...(brand !== "未知" && brand.toUpperCase() !== level ? [`产品  ${esc(brand)}`] : []),
          `商业  ${yesNo(business)}    ·    预付  ${yesNo(data?.prepaid)}`,
          `卡行  ${esc(checked.bank || field(data?.bank?.name))}`,
          ``,
          `<b>🌍 发卡地区</b>`,
          `国家  ${flag ? `${flag} ` : ""}${esc(countryName)}`,
          `代码  ${esc(countryCode || "未知")}    ·    区号  ${esc(country?.[0] ?? "未知")}`,
          `地区  ${esc(country ? continents[country[1]] ?? "未知" : "未知")}`,
          `货币  ${esc(currencyName(currency))}`,
          ``,
          `<b>💱 参考汇率</b>`,
          ...(rates ? [
            ...(currency && currency !== "USD" ? [rates.rates[currency] ? `<code>1 ${currency} = ${quote(rates.rates.CNY / rates.rates[currency])} CNY</code>` : `${esc(currency)} 汇率暂不可用`] : []),
            `<code>1 USD = ${quote(rates.rates.CNY)} CNY</code>`,
            `<i>${rates.updated ? `${rates.updated} · ` : ""}</i><a href="https://www.exchangerate-api.com">ExchangeRate-API</a>`,
          ] : ["汇率暂不可用"]),
          ...(numberDetails.length ? [``, `<blockquote expandable>${esc(numberDetails.join(" · "))}</blockquote>`] : []),
        ];
        const pages = await ui.renderRichText(lines.join("\n"));
        for (const [index, page] of pages.entries()) {
          ctx.signal.throwIfAborted();
          await ctx.telegram[index ? "reply" : "edit"](invocation.message, page, {parseMode:"html", linkPreview:false});
        }
      } catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "BIN 查询失败，请稍后重试"); }
    }},
  }});
}
