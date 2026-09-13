import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext} from "telebox/sdk";

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;"})[c]!);
const cities: Record<string, string> = {
  北京:"Beijing",上海:"Shanghai",广州:"Guangzhou",深圳:"Shenzhen",成都:"Chengdu",杭州:"Hangzhou",武汉:"Wuhan",西安:"Xi'an",重庆:"Chongqing",南京:"Nanjing",天津:"Tianjin",苏州:"Suzhou",长沙:"Changsha",郑州:"Zhengzhou",青岛:"Qingdao",大连:"Dalian",厦门:"Xiamen",香港:"Hong Kong",澳门:"Macau",台北:"Taipei",
  东京:"Tokyo",大阪:"Osaka",京都:"Kyoto",首尔:"Seoul",釜山:"Busan",曼谷:"Bangkok",新加坡:"Singapore",吉隆坡:"Kuala Lumpur",雅加达:"Jakarta",马尼拉:"Manila",河内:"Hanoi",胡志明市:"Ho Chi Minh City",迪拜:"Dubai",新德里:"New Delhi",孟买:"Mumbai",
  伦敦:"London",巴黎:"Paris",柏林:"Berlin",罗马:"Rome",马德里:"Madrid",巴塞罗那:"Barcelona",阿姆斯特丹:"Amsterdam",莫斯科:"Moscow",纽约:"New York",洛杉矶:"Los Angeles",旧金山:"San Francisco",芝加哥:"Chicago",华盛顿:"Washington",波士顿:"Boston",西雅图:"Seattle",多伦多:"Toronto",温哥华:"Vancouver",
  悉尼:"Sydney",墨尔本:"Melbourne",奥克兰:"Auckland",惠灵顿:"Wellington",
};
const codes: Record<number, [string, string]> = {0:["☀️","晴朗"],1:["🌤️","大部晴朗"],2:["⛅","部分多云"],3:["☁️","阴天"],45:["🌫️","有雾"],48:["🌫️","沉积雾凇"],51:["🌦️","轻度细雨"],53:["🌦️","中度细雨"],55:["🌦️","密集细雨"],56:["🌨️","轻度冻雨"],57:["🌨️","密集冻雨"],61:["🌧️","轻度降雨"],63:["🌧️","中度降雨"],65:["🌧️","强降雨"],66:["🌨️","轻度冻雨"],67:["🌨️","强冻雨"],71:["❄️","轻度降雪"],73:["❄️","中度降雪"],75:["❄️","强降雪"],77:["🌨️","雪粒"],80:["🌦️","轻度阵雨"],81:["🌧️","中度阵雨"],82:["⛈️","强阵雨"],85:["🌨️","轻度阵雪"],86:["🌨️","强阵雪"],95:["⛈️","雷暴"],96:["⛈️","轻度冰雹雷暴"],99:["⛈️","强冰雹雷暴"]};
const wind = (degree: unknown) => {
  if (typeof degree !== "number" || !Number.isFinite(degree)) return "未知";
  const index = ((Math.round(degree / 22.5) % 16) + 16) % 16;
  return ["北","北东北","东北","东东北","东","东东南","东南","南东南","南","南西南","西南","西西南","西","西西北","西北","北西北"][index];
};
const validCity = (s: string) => [...s].length > 0 && [...s].length <= 80 && !/[<>"`\u0000-\u001f\u007f]/u.test(s);

async function get(ctx: PluginContext, url: string, params: Record<string, string | number>): Promise<any> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));
  return ctx.http.json(target.toString(), {}, {timeoutMs:10000, redirects:{allowedHosts:[target.hostname], maxRedirects:2}});
}

async function cityQuery(ctx: PluginContext, city: string): Promise<string> {
  if (cities[city]) return cities[city]!;
  if (!/[\u4e00-\u9fff]/u.test(city)) return city;
  try {
    const translated = await get(ctx, "https://translate.googleapis.com/translate_a/single", {client:"gtx", sl:"auto", tl:"en", dt:"t", q:city});
    const value = translated?.[0]?.map((part: unknown) => Array.isArray(part) && typeof part[0] === "string" ? part[0] : "").join("").trim();
    return value || city;
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.log.error("weather.translation_failed");
    return city;
  }
}

function report(name: string, data: any): string {
  const c = data?.current, d = data?.daily;
  if (!c || !d?.temperature_2m_max?.length || !d?.temperature_2m_min?.length) throw new Error("天气数据格式无效");
  const required = [c.temperature_2m, c.apparent_temperature, c.relative_humidity_2m, c.weather_code,
    c.wind_speed_10m, d.temperature_2m_max[0], d.temperature_2m_min[0]];
  const optional = [c.precipitation, c.rain, c.snowfall, c.cloud_cover, c.pressure_msl,
    c.wind_direction_10m, c.wind_gusts_10m].filter(value => value !== undefined);
  if ([...required, ...optional].some(value => typeof value !== "number" || !Number.isFinite(value))) throw new Error("天气数据格式无效");
  const [icon, description] = codes[c.weather_code] ?? ["🌤️", "未知"];
  const warnings: string[] = [];
  if (c.temperature_2m > 35) warnings.push(`🔥 高温预警：${c.temperature_2m}°C`);
  else if (c.temperature_2m < -10) warnings.push(`❄️ 低温预警：${c.temperature_2m}°C`);
  if (c.wind_speed_10m > 40) warnings.push(`💨 大风预警：风速 ${c.wind_speed_10m} km/h`);
  if (c.precipitation > 10) warnings.push(`🌧️ 强降水预警：${c.precipitation} mm`);
  if (c.weather_code >= 95 && c.weather_code <= 99) warnings.push("⛈️ 雷暴预警：请注意安全");
  else if (c.weather_code >= 71 && c.weather_code <= 77) warnings.push("🌨️ 降雪预警：路面可能结冰");
  else if (c.weather_code === 45 || c.weather_code === 48) warnings.push("🌫️ 大雾预警：能见度低");
  const extras = [
    c.wind_gusts_10m > 0 && `🌪️ <b>阵风:</b> ${c.wind_gusts_10m} km/h`,
    c.precipitation > 0 && `🌧️ <b>降水量:</b> ${c.precipitation} mm`,
    c.rain > 0 && `☔ <b>降雨量:</b> ${c.rain} mm`,
    c.snowfall > 0 && `❄️ <b>降雪量:</b> ${c.snowfall} cm`,
  ].filter(Boolean).join("\n");
  const text = `<b>📍 ${esc(name)}</b>\n\n${icon} <b>${description}</b>\n\n🌡️ <b>温度:</b> ${c.temperature_2m}°C\n🤔 <b>体感:</b> ${c.apparent_temperature}°C\n📊 <b>今日最高/最低:</b> ${d.temperature_2m_max[0]}°C / ${d.temperature_2m_min[0]}°C\n💧 <b>湿度:</b> ${c.relative_humidity_2m}%\n💨 <b>风速:</b> ${c.wind_speed_10m} km/h (${wind(c.wind_direction_10m)}风)\n${extras ? `${extras}\n` : ""}🔵 <b>气压:</b> ${Math.round(c.pressure_msl ?? 0)} hPa\n☁️ <b>云量:</b> ${c.cloud_cover ?? 0}%\n🌅 <b>日出:</b> ${String(d.sunrise?.[0] ?? "").slice(11,16)}\n🌇 <b>日落:</b> ${String(d.sunset?.[0] ?? "").slice(11,16)}${warnings.length ? `\n\n<b>⚠️ 天气提醒</b>\n${warnings.join("\n")}` : ""}\n\n<i>数据来源: Open-Meteo (免费API)</i>`;
  if (text.length > 4000) throw new Error("天气报告过长");
  return text;
}

export default function createWeather() {
  return definePlugin({renderHelp:renderPluginHelp, apiVersion:1, id:"weather", description:"查询城市天气", commands:{weather:{helpArgs:["help","h"], helpOnEmpty:true, description:"查询城市天气", async handle(invocation, ctx) {
    const city = invocation.args.join(" ").trim();
    const selector = invocation.args[0]?.toLowerCase();
    if (!city || selector === "help" || selector === "h") { await ctx.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), {parseMode:"html"}); return; }
    if (!validCity(city)) { await ctx.telegram.edit(invocation.message, "请输入有效的城市名"); return; }
    await ctx.telegram.edit(invocation.message, `🔍 <b>正在识别城市...</b>\n<i>${esc(city)}</i>`, {parseMode:"html"});
    const name = await cityQuery(ctx, city);
    await ctx.telegram.edit(invocation.message, name === city ? `🌍 <b>正在搜索 ${esc(name)}...</b>` : `🌍 <b>正在搜索...</b>\n<i>${esc(city)} → ${esc(name)}</i>`, {parseMode:"html"});
    let geo: any;
    try { geo = await get(ctx, "https://geocoding-api.open-meteo.com/v1/search", {name, count:10, language:"zh", format:"json"}); }
    catch (error) { if (ctx.signal.aborted) throw error; await ctx.telegram.edit(invocation.message, "天气查询失败，请稍后重试"); return; }
    const place = geo?.results?.[0];
    if (!place) { await ctx.telegram.edit(invocation.message, "未找到该城市"); return; }
    if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) { await ctx.telegram.edit(invocation.message, "天气查询失败，请稍后重试"); return; }
    const label = [place.name, place.admin1 !== place.name ? place.admin1 : undefined, place.country].filter(value => value && value !== "undefined").join(", ");
    await ctx.telegram.edit(invocation.message, `🌡️ <b>正在获取 ${esc(label)} 的天气...</b>`, {parseMode:"html"});
    let output: string;
    try {
      const data = await get(ctx, "https://api.open-meteo.com/v1/forecast", {latitude:place.latitude, longitude:place.longitude, current:"temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m", daily:"weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,wind_speed_10m_max", timezone:"auto", forecast_days:1});
      output = report(label, data);
    } catch (error) { if (ctx.signal.aborted) throw error; await ctx.telegram.edit(invocation.message, "天气查询失败，请稍后重试"); return; }
    await ctx.telegram.edit(invocation.message, output, {parseMode:"html"});
  }}}});
}
