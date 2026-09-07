import {Api} from "teleproto";
import {definePlugin, type PluginContext, type PluginDefinition} from "telebox/sdk";

type Mode = "time" | "text" | "both";
interface UserSettings { user_id: string; timezone: string; original_first_name: string | null; original_last_name: string | null; is_enabled: boolean; mode: Mode; last_update: string | null; text_index: number; show_clock_emoji?: boolean; show_time?: boolean; show_timezone?: boolean; timezone_format?: string; display_order?: string; displayComponents?: string[]; text_style?: string; weather_enabled?: boolean; weather_location?: string; weather_compact?: string; weather_cache_ts?: number; }
interface State extends Record<string, unknown> { schemaVersion: number; users: Record<string, UserSettings>; random_texts: string[]; }
const defaults: State = {schemaVersion: 1, users: {}, random_texts: []};
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const validZone = (zone: string) => { try { new Intl.DateTimeFormat("en", {timeZone: zone}).format(); return true; } catch { return false; } };
const time = (zone: string) => new Intl.DateTimeFormat("zh-CN", {timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).format(new Date());
const cleanName = (name: string) => name.slice(0, 128).replace(/\b\d{1,2}:\d{2}(\s?(AM|PM))?\b/gi, "").replace(/[\u{1F550}-\u{1F567}]/gu, "").replace(/\s+/g, " ").trim();
const clock = (zone: string) => {const hour = Number(new Intl.DateTimeFormat("en", {timeZone: zone, hour: "numeric", hourCycle: "h23"}).format(new Date())) % 12; return String.fromCodePoint(0x1f550 + hour);};
const zoneLabel = (zone: string, format = "GMT") => {if (format.startsWith("custom:")) return format.slice(7); const name = new Intl.DateTimeFormat("en", {timeZone: zone, timeZoneName: "longOffset"}).formatToParts().find(part => part.type === "timeZoneName")?.value || zone; return format.toUpperCase() === "UTC" ? name.replace("GMT", "UTC") : name;};
const weatherEmoji = (code: number) => code === 0 ? "☀️" : code >= 95 ? "⛈️" : code >= 71 ? "❄️" : code >= 61 ? "🌧️" : code >= 45 ? "🌫️" : "⛅";
async function weather(context: PluginContext, user: UserSettings): Promise<string> {
  if (!user.weather_enabled || !user.weather_location) return "";
  if (user.weather_compact && user.weather_cache_ts && Date.now() - user.weather_cache_ts < 1_800_000) return user.weather_compact;
  try {
    const geo = await context.http.json<any>(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(user.weather_location)}&count=1&language=zh&format=json`, {}, {timeoutMs: 10_000, redirects: {allowedHosts: ["geocoding-api.open-meteo.com"], maxRedirects: 2}});
    const location = geo?.results?.[0]; if (!location || typeof location.latitude !== "number" || typeof location.longitude !== "number") return "";
    const forecast = await context.http.json<any>(`https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,weather_code&timezone=auto`, {}, {timeoutMs: 10_000, redirects: {allowedHosts: ["api.open-meteo.com"], maxRedirects: 2}});
    const current = forecast?.current; if (!current || typeof current.temperature_2m !== "number" || typeof current.weather_code !== "number") return "";
    return `${weatherEmoji(current.weather_code)} ${Math.round(current.temperature_2m)}°C`;
  } catch { return ""; }
}

async function updateUser(context: PluginContext, userId: string, force = false): Promise<boolean> {
  const store = context.storage.json<State>("autochangename.json", defaults);
  const state = await store.read(); const user = state.users[userId];
  if (!user || (!force && !user.is_enabled) || !user.original_first_name) return false;
  if (!force && user.last_update && Date.now() - Date.parse(user.last_update) < 30_000) return false;
  const texts = state.random_texts;
  const components: Record<string, string> = {name: user.original_first_name, text: "", time: "", emoji: "", timezone: "", weather: ""};
  if ((user.mode === "text" || user.mode === "both") && texts.length) components.text = texts[user.text_index % texts.length];
  if (user.show_time !== false && (user.mode === "time" || user.mode === "both")) components.time = time(user.timezone);
  if (user.show_clock_emoji) components.emoji = clock(user.timezone);
  if (user.show_timezone) components.timezone = zoneLabel(user.timezone, user.timezone_format);
  components.weather = await weather(context, user);
  const requested = (user.display_order || "name,text,time,weather,emoji,timezone").split(",").map(value => value.trim());
  const pieces = [...new Set([...requested, "name", "text", "time", "weather", "emoji", "timezone"])].map(key => components[key]).filter(Boolean);
  const firstName = pieces.filter(Boolean).join(" ").slice(0, 64);
  try {
    await context.telegram.withClient(async client => client.invoke(new Api.account.UpdateProfile({firstName, lastName: user.original_last_name || undefined})));
    await store.update(current => { const next = current.users[userId]; if (next) {next.last_update = new Date().toISOString(); if (components.weather) {next.weather_compact = components.weather; next.weather_cache_ts = Date.now();} if (texts.length && next.mode !== "time") next.text_index = (next.text_index + 1) % texts.length;} return {...current, schemaVersion: 1}; });
    return true;
  } catch (error) {
    if (String(error).includes("FLOOD_WAIT")) await store.update(current => {if (current.users[userId]) current.users[userId].is_enabled = false; return current;});
    if (String(error).includes("USERNAME_NOT_MODIFIED")) return true;
    return false;
  }
}

export default function createAutoChangeName(): PluginDefinition {
  return definePlugin({apiVersion: 1, id: "autochangename", description: "按时区自动更新账号昵称",
    commands: {
      acn: {description: "管理动态昵称", async handle(invocation, context) {
        const store = context.storage.json<State>("autochangename.json", defaults); const sub = invocation.args[0]?.toLowerCase(); const userId = invocation.message.senderId;
        if (!userId) return context.telegram.edit(invocation.message, "❌ 无法识别您的身份", {});
        if (!sub || sub === "help" || sub === "h") return context.telegram.edit(invocation.message, `<b>自动昵称</b>\n<code>${invocation.prefix}acn save/on/off/mode/tz/update/reset/status</code>`, {parseMode: "html"});
        if (sub === "status") { const state = await store.read(); return context.telegram.edit(invocation.message, `📊 自动更新: <code>运行中</code>\n启用用户: <code>${Object.values(state.users).filter(v => v.is_enabled).length}</code>`, {parseMode: "html"}); }
        if (sub === "save") {
          const profile = await context.telegram.withClient(async client => client.getMe());
          await store.update(state => { const old = state.users[userId]; state.users[userId] = {...old, user_id: userId, timezone: old?.timezone || "Asia/Shanghai", original_first_name: cleanName(profile.firstName || ""), original_last_name: cleanName(profile.lastName || "") || null, is_enabled: old?.is_enabled || false, mode: old?.mode || "time", last_update: old?.last_update || null, text_index: old?.text_index || 0}; return {...state, schemaVersion: 1}; });
          return context.telegram.edit(invocation.message, "✅ 原始昵称已保存", {});
        }
        const state = await store.read(); const user = state.users[userId];
        if (!user?.original_first_name) return context.telegram.edit(invocation.message, `❌ 请先 <code>${invocation.prefix}acn save</code>`, {parseMode: "html"});
        if (["on", "enable", "off", "disable"].includes(sub)) {
          const enabled = sub === "on" || sub === "enable"; await store.update(current => {current.users[userId].is_enabled = enabled; return current;});
          if (enabled) await updateUser(context, userId, true); else await context.telegram.withClient(async client => client.invoke(new Api.account.UpdateProfile({firstName: user.original_first_name!, lastName: user.original_last_name || undefined})));
          return context.telegram.edit(invocation.message, `✅ 动态昵称已${enabled ? "启用" : "禁用"}`, {});
        }
        if (sub === "mode") { const next: Record<Mode, Mode> = {time: "text", text: "both", both: "time"}; await store.update(current => {current.users[userId].mode = next[current.users[userId].mode]; return current;}); return context.telegram.edit(invocation.message, `✅ 显示模式: <code>${next[user.mode]}</code>`, {parseMode: "html"}); }
        if (sub === "tz" || sub === "timezone") { const value = invocation.args[1]?.toLowerCase();
          if (value === "list") return context.telegram.edit(invocation.message, "Asia/Shanghai\nAsia/Tokyo\nEurope/London\nAmerica/New_York", {});
          if (value === "on" || value === "off") {await store.update(current => {current.users[userId].show_timezone = value === "on"; return current;}); return context.telegram.edit(invocation.message, `✅ 时区显示已${value === "on" ? "开启" : "关闭"}`, {});}
          if (value === "format") {const format = invocation.args.slice(2).join(" "); if (!/^(gmt|utc|simp|offset|custom:.+)$/i.test(format)) return context.telegram.edit(invocation.message, "❌ 无效的时区格式", {}); await store.update(current => {current.users[userId].timezone_format = format.toUpperCase().startsWith("CUSTOM:") ? `custom:${format.slice(7)}` : format.toUpperCase(); return current;}); return context.telegram.edit(invocation.message, "✅ 时区格式已更新", {});}
          const zone = invocation.args.slice(value === "set" ? 2 : 1).join(" "); if (!zone || !validZone(zone)) return context.telegram.edit(invocation.message, "❌ 无效的时区标识符", {}); await store.update(current => {current.users[userId].timezone = zone; return current;}); return context.telegram.edit(invocation.message, `✅ 时区已更新为: <code>${escape(zone)}</code>`, {parseMode: "html"}); }
        if (sub === "text") {const action = invocation.args[1]?.toLowerCase();
          if (action === "list") return context.telegram.edit(invocation.message, state.random_texts.length ? state.random_texts.map((text, index) => `${index + 1}. ${escape(text)}`).join("\n") : "📝 无随机文本", {parseMode: "html"});
          if (action === "clear") {await store.update(current => ({...current, random_texts: []})); return context.telegram.edit(invocation.message, "✅ 所有文本已清空", {});}
          if (action === "add") {const additions = invocation.args.slice(2).join(" ").split(/\r?\n/).map(value => value.trim()).filter(value => value && value.length <= 50); await store.update(current => ({...current, random_texts: [...new Set([...current.random_texts, ...additions])].slice(0, 100)})); return context.telegram.edit(invocation.message, `✅ 成功添加 ${additions.length} 条`, {});}
          if (action === "del") {const index = Number(invocation.args[2]) - 1; if (!Number.isInteger(index) || index < 0 || index >= state.random_texts.length) return context.telegram.edit(invocation.message, "❌ 无效的索引号", {}); await store.update(current => ({...current, random_texts: current.random_texts.filter((_value, currentIndex) => currentIndex !== index)})); return context.telegram.edit(invocation.message, "✅ 文本已删除", {});}
          if (action === "on" || action === "off") {await store.update(current => {current.users[userId].mode = action === "on" ? (current.users[userId].show_time === false ? "text" : "both") : "time"; return current;}); return context.telegram.edit(invocation.message, `✅ 随机文案已${action === "on" ? "开启" : "关闭"}`, {});}
        }
        if (["emoji", "time"].includes(sub)) {const enabled = invocation.args[1]?.toLowerCase(); if (enabled !== "on" && enabled !== "off") return context.telegram.edit(invocation.message, `请使用 ${invocation.prefix}acn ${sub} on/off`, {}); await store.update(current => {if (sub === "emoji") current.users[userId].show_clock_emoji = enabled === "on"; else current.users[userId].show_time = enabled === "on"; return current;}); return context.telegram.edit(invocation.message, `✅ ${sub === "emoji" ? "时钟Emoji" : "时间显示"}已${enabled === "on" ? "开启" : "关闭"}`, {});}
        if (sub === "order") {const values = invocation.args.slice(1).join(" ").split(/[,\s]+/).filter(Boolean); const allowed = ["name", "text", "time", "weather", "emoji", "timezone"]; if (!values.length) return context.telegram.edit(invocation.message, `当前顺序: <code>${escape(user.display_order || "name,time")}</code>`, {parseMode: "html"}); if (values.some(value => !allowed.includes(value))) return context.telegram.edit(invocation.message, "❌ 无效组件", {}); const order = [...new Set(values)].join(","); await store.update(current => {current.users[userId].display_order = order; return current;}); return context.telegram.edit(invocation.message, `✅ 显示顺序: <code>${order}</code>`, {parseMode: "html"});}
        if (sub === "style") {const style = invocation.args[1]?.toLowerCase(); if (!["normal", "italic", "double", "sans", "mono", "outline"].includes(style || "")) return context.telegram.edit(invocation.message, "可用样式: normal, italic, double, sans, mono, outline", {}); await store.update(current => {current.users[userId].text_style = style; return current;}); return context.telegram.edit(invocation.message, `✅ 文字样式: ${style}`, {});}
        if (sub === "weather") {const action = invocation.args[1]?.toLowerCase(); if (!action) return context.telegram.edit(invocation.message, `天气: ${user.weather_enabled ? "开" : "关"}\n地点: ${escape(user.weather_location || "未设置")}`, {parseMode: "html"}); if (action === "on" && !user.weather_location) return context.telegram.edit(invocation.message, "❌ 请先设置地点", {}); await store.update(current => {const target = current.users[userId]; if (action === "on" || action === "off") target.weather_enabled = action === "on"; else {target.weather_location = invocation.args.slice(action === "set" ? 2 : 1).join(" "); target.weather_enabled = true; target.weather_compact = ""; target.weather_cache_ts = 0;} return current;}); return context.telegram.edit(invocation.message, "✅ 天气配置已更新", {});}
        if (sub === "config") return context.telegram.edit(invocation.message, `🔧 <b>您的配置状态</b>\n自动更新: <code>${user.is_enabled ? "开" : "关"}</code>\n模式: <code>${user.mode}</code>\n时区: <code>${escape(user.timezone)}</code>\n文案数: <code>${state.random_texts.length}</code>`, {parseMode: "html"});
        if (sub === "update" || sub === "now") { const ok = await updateUser(context, userId, true); return context.telegram.edit(invocation.message, ok ? "✅ 昵称已手动更新" : "❌ 更新失败", {}); }
        if (sub === "reset") { await store.update(current => {current.users[userId].is_enabled = false; return current;}); await context.telegram.withClient(async client => client.invoke(new Api.account.UpdateProfile({firstName: user.original_first_name!, lastName: user.original_last_name || undefined}))); return context.telegram.edit(invocation.message, "✅ 已恢复原始昵称并禁用自动更新", {}); }
        return context.telegram.edit(invocation.message, `❌ 未知命令: <code>${escape(sub)}</code>`, {parseMode: "html"});
      }},
      autochangename: {description: "管理动态昵称", async handle(invocation, context) { return createAutoChangeName().commands.acn.handle(invocation, context); }},
    },
    jobs: {update_names: {cron: "0 * * * * *", timeZone: "Asia/Shanghai", description: "每分钟更新已启用昵称", async handle(context) { const state = await context.storage.json<State>("autochangename.json", defaults).read(); for (const id of Object.keys(state.users).filter(id => state.users[id].is_enabled)) { context.signal.throwIfAborted(); await updateUser(context, id); } }}},
    async setup(context) { await context.storage.json<State>("autochangename.json", defaults).update(state => ({...state, schemaVersion: 1,
      users: Object.fromEntries(Object.entries(state.users || {}).map(([id, user]) => [id, {...user, user_id: String(user.user_id ?? id), timezone: validZone(user.timezone) ? user.timezone : "Asia/Shanghai"}])),
      random_texts: Array.isArray(state.random_texts) ? state.random_texts.filter((text): text is string => typeof text === "string").slice(0, 100) : []})); },
  });
}
