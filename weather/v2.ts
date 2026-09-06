import {definePlugin, type PluginContext} from "telebox/sdk";

const escape = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
const help = `<b>天气查询</b>\n<code>weather 北京</code>\n<code>weather New York</code>`;
const cities: Record<string, string> = {北京:"Beijing",上海:"Shanghai",广州:"Guangzhou",深圳:"Shenzhen",成都:"Chengdu",杭州:"Hangzhou",武汉:"Wuhan",西安:"Xi'an",重庆:"Chongqing",南京:"Nanjing",天津:"Tianjin",苏州:"Suzhou",长沙:"Changsha",郑州:"Zhengzhou",青岛:"Qingdao",大连:"Dalian",厦门:"Xiamen",香港:"Hong Kong",澳门:"Macau",台北:"Taipei",东京:"Tokyo",大阪:"Osaka",京都:"Kyoto",首尔:"Seoul",曼谷:"Bangkok",新加坡:"Singapore",吉隆坡:"Kuala Lumpur",雅加达:"Jakarta",伦敦:"London",巴黎:"Paris",柏林:"Berlin",罗马:"Rome",纽约:"New York",洛杉矶:"Los Angeles",旧金山:"San Francisco",芝加哥:"Chicago",多伦多:"Toronto",悉尼:"Sydney",墨尔本:"Melbourne"};
const codes: Record<number, [string, string]> = {0:["☀️","晴朗"],1:["🌤️","大部晴朗"],2:["⛅","部分多云"],3:["☁️","阴天"],45:["🌫️","有雾"],48:["🌫️","沉积雾凇"],51:["🌦️","轻度细雨"],53:["🌦️","中度细雨"],55:["🌦️","密集细雨"],56:["🌨️","轻度冻雨"],57:["🌨️","密集冻雨"],61:["🌧️","轻度降雨"],63:["🌧️","中度降雨"],65:["🌧️","强降雨"],66:["🌨️","轻度冻雨"],67:["🌨️","强冻雨"],71:["❄️","轻度降雪"],73:["❄️","中度降雪"],75:["❄️","强降雪"],77:["🌨️","雪粒"],80:["🌦️","轻度阵雨"],81:["🌧️","中度阵雨"],82:["⛈️","强阵雨"],85:["🌨️","轻度阵雪"],86:["🌨️","强阵雪"],95:["⛈️","雷暴"],96:["⛈️","轻度冰雹雷暴"],99:["⛈️","强冰雹雷暴"]};
const windDirection = (degree: unknown) => {
  if (typeof degree !== "number" || !Number.isFinite(degree)) return "未知";
  return ["北","北东北","东北","东东北","东","东东南","东南","南东南","南","南西南","西南","西西南","西","西西北","西北","北西北"][Math.round(degree / 22.5) % 16];
};
const validCity = (s: string) => s.length > 0 && s.length <= 80 && !/[<>"'`]/.test(s);
const format = (name: string, geo: any, data: any) => {
  const c = data?.current, d = data?.daily;
  if (!c || !d?.temperature_2m_max?.length) throw new Error("天气数据格式无效");
  const [icon, description] = codes[c.weather_code] ?? ["🌤️", "未知"];
  const warnings: string[] = [];
  if (c.temperature_2m > 35) warnings.push(`🔥 高温预警：${c.temperature_2m}°C`);
  if (c.temperature_2m < -10) warnings.push(`❄️ 低温预警：${c.temperature_2m}°C`);
  if (c.wind_speed_10m > 40) warnings.push(`💨 大风预警：风速 ${c.wind_speed_10m} km/h`);
  if (c.precipitation > 10) warnings.push(`🌧️ 强降水预警：${c.precipitation} mm`);
  if (c.weather_code >= 95) warnings.push("⛈️ 雷暴预警：请注意安全");
  const extra = [
    c.wind_gusts_10m > 0 && `🌪️ <b>阵风:</b> ${c.wind_gusts_10m} km/h`,
    c.precipitation > 0 && `🌧️ <b>降水:</b> ${c.precipitation} mm`,
    c.rain > 0 && `☔ <b>降雨:</b> ${c.rain} mm`,
    c.snowfall > 0 && `❄️ <b>降雪:</b> ${c.snowfall} cm`,
  ].filter(Boolean).join("\n");
  const text = `<b>📍 ${escape(name)}</b>\n\n${icon} <b>${description}</b>\n\n🌡️ <b>温度:</b> ${c.temperature_2m}°C\n🤔 <b>体感:</b> ${c.apparent_temperature}°C\n📊 <b>今日最高/最低:</b> ${d.temperature_2m_max[0]}°C / ${d.temperature_2m_min[0]}°C\n💧 <b>湿度:</b> ${c.relative_humidity_2m}%\n💨 <b>风速:</b> ${c.wind_speed_10m} km/h (${windDirection(c.wind_direction_10m)}风)\n${extra ? `${extra}\n` : ""}🔵 <b>气压:</b> ${Math.round(c.pressure_msl ?? 0)} hPa\n☁️ <b>云量:</b> ${c.cloud_cover ?? 0}%\n🌅 <b>日出:</b> ${String(d.sunrise?.[0] ?? "").slice(11,16)}\n🌇 <b>日落:</b> ${String(d.sunset?.[0] ?? "").slice(11,16)}${warnings.length ? `\n\n<b>⚠️ 天气提醒</b>\n${warnings.join("\n")}` : ""}\n\n<i>数据来源: Open-Meteo (免费API)</i>`;
  if (text.length > 4000) throw new Error("天气报告过长");
  return text;
};
async function get(ctx: PluginContext, url: string, params: Record<string, string | number>): Promise<any> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));
  return ctx.http.json(target.toString(), {}, {timeoutMs: 10000});
}
export default function createWeather() {
  return definePlugin({apiVersion: 1, id: "weather", description: "查询城市天气", commands: {
    weather: {description: "查询城市天气", async handle(invocation, ctx) {
      const city = invocation.args.join(" ").trim();
      if (!city || city.toLowerCase() === "help" || city.toLowerCase() === "h") { await ctx.telegram.edit(invocation.message, help, {parseMode:"html"}); return; }
      if (!validCity(city)) { await ctx.telegram.edit(invocation.message, "请输入有效的城市名"); return; }
      try {
        await ctx.telegram.edit(invocation.message, `🔍 正在查询 <b>${escape(city)}</b>…`, {parseMode:"html"});
        const name = cities[city] ?? city;
        const geo = await get(ctx, "https://geocoding-api.open-meteo.com/v1/search", {name, count:1, language:"zh", format:"json"});
        const place = geo?.results?.[0];
        if (!place) { await ctx.telegram.edit(invocation.message, "未找到该城市"); return; }
        const data = await get(ctx, "https://api.open-meteo.com/v1/forecast", {latitude: place.latitude, longitude: place.longitude, current:"temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m", daily:"weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,wind_speed_10m_max", timezone:"auto", forecast_days:1});
        const label = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
        await ctx.telegram.edit(invocation.message, format(label, place, data), {parseMode:"html"});
      } catch (error) { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "天气查询失败，请稍后重试"); }
    }},
  }});
}
