import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type PluginContext, type PluginDefinition} from "telebox/sdk";
import {Api} from "teleproto";
import {NameAppearance} from "./v2/appearance";
import {weatherCity, weatherEmoji} from "./v2/weather";

const appearance = new NameAppearance();

type Mode = "time" | "text" | "both";
interface UserSettings { user_id: string; timezone: string; original_first_name: string | null; original_last_name: string | null; is_enabled: boolean; mode: Mode; last_update: string | null; text_index: number; show_clock_emoji?: boolean; show_time?: boolean; show_timezone?: boolean; timezone_format?: string; display_order?: string; displayComponents?: string[]; text_style?: string; weather_enabled?: boolean; weather_location?: string; weather_compact?: string; weather_cache_ts?: number; }
interface State extends Record<string, unknown> { schemaVersion: number; users: Record<string, UserSettings>; random_texts: string[]; }
const defaults: State = {schemaVersion: 1, users: {}, random_texts: []};
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const validZone = (zone: string) => { try { new Intl.DateTimeFormat("en", {timeZone: zone}).format(); return true; } catch { return false; } };
const time = (zone: string) => new Intl.DateTimeFormat("zh-CN", {timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).format(new Date());
const cleanName = (name: string) => name.slice(0, 128).replace(/\b\d{1,2}:\d{2}(\s?(AM|PM))?\b/gi, "").replace(/[\u{1F550}-\u{1F567}]/gu, "").replace(/\s+/g, " ").trim();
const clock = (zone: string) => {const hour = Number(new Intl.DateTimeFormat("en", {timeZone: zone, hour: "numeric", hourCycle: "h23"}).format(new Date())) % 12; return String.fromCodePoint(0x1f550 + (hour + 11) % 12);};
const zoneLabel = (zone: string, format = "GMT") => appearance.timezoneLabel(zone, format);
async function weather(context: PluginContext, user: UserSettings): Promise<{text: string; fetchedAt?: number}> {
  if (!user.weather_enabled || !user.weather_location) return {text: ""};
  if (user.weather_cache_ts && Date.now() - user.weather_cache_ts < (user.weather_compact ? 1_800_000 : 300_000)) return {text: user.weather_compact || ""};
  try {
    const geo = await context.http.json<any>(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(weatherCity(user.weather_location))}&count=1&language=zh&format=json`, {}, {timeoutMs: 10_000, redirects: {allowedHosts: ["geocoding-api.open-meteo.com"], maxRedirects: 2}});
    const location = geo?.results?.[0]; if (!location || typeof location.latitude !== "number" || typeof location.longitude !== "number") return {text: "", fetchedAt: Date.now()};
    const forecast = await context.http.json<any>(`https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,weather_code&timezone=auto`, {}, {timeoutMs: 10_000, redirects: {allowedHosts: ["api.open-meteo.com"], maxRedirects: 2}});
    const current = forecast?.current; if (!current || typeof current.temperature_2m !== "number" || typeof current.weather_code !== "number") return {text: "", fetchedAt: Date.now()};
    return {text: `${weatherEmoji(current.weather_code)} ${Math.round(current.temperature_2m)}°C`, fetchedAt: Date.now()};
  } catch { context.signal.throwIfAborted(); return {text: "", fetchedAt: Date.now()}; }
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
  const currentWeather = await weather(context, user);
  components.weather = currentWeather.text;
  const requested = (user.display_order || "name,text,time,weather,emoji,timezone").split(",").map(value => value.trim());
  const pieces = [...new Set([...requested, "name", "text", "time", "weather", "emoji", "timezone"])].map(key => {
    const value = components[key] || "";
    return key === "name" ? value : appearance.applyTextStyle(value, user.text_style as Parameters<NameAppearance["applyTextStyle"]>[1]);
  }).filter(Boolean);
  const firstName = Array.from(pieces.join(" ")).slice(0, 64).join("");
  try {
    await context.telegram.withClient(async client => client.invoke(new Api.account.UpdateProfile({firstName, lastName: user.original_last_name || undefined})));
    await store.update(current => { const next = current.users[userId]; if (next) {next.last_update = new Date().toISOString(); if (currentWeather.fetchedAt !== undefined) {next.weather_compact = currentWeather.text; next.weather_cache_ts = currentWeather.fetchedAt;} if (texts.length && next.mode !== "time") next.text_index = (next.text_index + 1) % texts.length;} return {...current, schemaVersion: 1}; });
    return true;
  } catch (error) {
    if (String(error).includes("FLOOD_WAIT")) await store.update(current => {if (current.users[userId]) current.users[userId].is_enabled = false; return current;});
    if (String(error).includes("USERNAME_NOT_MODIFIED")) return true;
    return false;
  }
}

export default function createAutoChangeName(): PluginDefinition {
  const store = (context: PluginContext) => context.storage.json<State>("autochangename.json", defaults);
  const mutate = async (context: PluginContext, userId: string, transform: (user: UserSettings) => void): Promise<UserSettings | undefined> => {
    let result: UserSettings | undefined;
    await store(context).update(current => {
      const target = current.users[userId];
      if (!target) return current;
      transform(target);
      result = target;
      return current;
    });
    return result;
  };
  const needUser = async (invocation: CommandInvocation, context: PluginContext, run: (state: State, user: UserSettings) => Promise<void>): Promise<void> => {
    const state = await store(context).read(); const user = state.users[invocation.message.senderId ?? ""];
    if (!user?.original_first_name) { await context.telegram.edit(invocation.message, `❌ 请先 <code>${invocation.prefix}acn save</code>`, {parseMode: "html"}); return; }
    await run(state, user);
  };
  const edit = (context: PluginContext, invocation: CommandInvocation, text: string, html = false) =>
    context.telegram.edit(invocation.message, text, html ? {parseMode: "html", linkPreview: false} : {});
  // tz/text/weather all depend on the saved profile; save/status keep their own exemptions.
  const saveAuthorize = async (invocation: CommandInvocation, context: PluginContext): Promise<boolean> => {
    const state = await store(context).read();
    const user = state.users[invocation.message.senderId ?? ""];
    if (!user?.original_first_name) { await edit(context, invocation, `❌ 请先 <code>${invocation.prefix}acn save</code>`, true); return false; }
    return true;
  };
  const trigger = (enabled: boolean) => async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const userId = invocation.message.senderId!;
    await needUser(invocation, context, async (_state, user) => {
      await mutate(context, userId, target => {target.is_enabled = enabled;});
      if (enabled) await updateUser(context, userId, true);
      else await context.telegram.withClient(async client => client.invoke(new Api.account.UpdateProfile({firstName: user.original_first_name!, lastName: user.original_last_name || undefined})));
      await edit(context, invocation, `✅ 动态昵称已${enabled ? "启用" : "禁用"}`);
    });
  };
  const acnCommand: CommandDefinition = {
    description: "管理动态昵称",
    helpArgs: ["help", "h"],
    helpOnEmpty: true,
    authorize: async (invocation, context) => {
      if (!invocation.message.senderId) { await edit(context, invocation, "❌ 无法识别您的身份"); return false; }
      return true;
    },
    args: "save|on|off|mode|tz|text|emoji|time|order|style|weather|config|update|reset|status",
    arguments: [{name: "子命令", description: "要执行的管理动作"}],
    subcommandsCaseSensitive: false,
    subcommands: {
      save: {
        group: "🔧 基础操作：",description: "保存当前昵称为原始基准", args: "", examples: [{args: "save"}], handle: async (invocation, context) => {
        const userId = invocation.message.senderId!;
        const profile = await context.telegram.withClient(async client => client.getMe());
        await store(context).update(state => { const old = state.users[userId]; state.users[userId] = {...old, user_id: userId, timezone: old?.timezone || "Asia/Shanghai", original_first_name: cleanName(profile.firstName || ""), original_last_name: cleanName(profile.lastName || "") || null, is_enabled: old?.is_enabled || false, mode: old?.mode || "time", last_update: old?.last_update || null, text_index: old?.text_index || 0}; return {...state, schemaVersion: 1}; });
        await edit(context, invocation, "✅ 原始昵称已保存");
      }, help: [{heading: "说明：", body: "首次使用必须先 save。保存/更新「原始昵称」基准（只改姓名，其它配置保留）。保存后，插件会以此为基准，在每次更新时加上时间、文案等内容。\n⚠️ 建议在“干净”昵称下执行；已有 weather/style/order 等设置不会被清空。"}]},
      on: {
        group: "🔧 基础操作：",aliases: ["enable"], description: "开启自动更新", args: "", examples: [{args: "on"}], handle: trigger(true), help: [{heading: "说明：", body: "开启或关闭自动昵称更新功能。开启后每分钟自动更新一次，关闭后恢复已保存的原始昵称。enable/disable 为别名命令（同上）。被限流时会自动停用。"}]},
      off: {
        group: "🔧 基础操作：",aliases: ["disable"], description: "关闭自动更新并恢复原始昵称", args: "", examples: [{args: "off"}], handle: trigger(false)},
      status: {
        group: "📊 查看配置：",description: "查看插件运行状态：自动更新是否运行、启用的用户数量", args: "", examples: [{args: "status"}], handle: async (invocation, context) => {
        const state = await store(context).read();
        await edit(context, invocation, `📊 自动更新: <code>运行中</code>\n启用用户: <code>${Object.values(state.users).filter(v => v.is_enabled).length}</code>`, true);
      }},
      mode: {
        group: "🔧 基础操作：",description: "循环切换显示模式 time→text→both", args: "", examples: [{args: "mode"}], handle: async (invocation, context) => {
        const userId = invocation.message.senderId!;
        await needUser(invocation, context, async () => {
          const next: Record<Mode, Mode> = {time: "text", text: "both", both: "time"};
          const updated = await mutate(context, userId, target => {target.mode = next[target.mode];});
          await edit(context, invocation, `✅ 显示模式: <code>${updated?.mode ?? ""}</code>`, true);
        });
      }, help: [{heading: "说明：", body: "循环切换显示模式：time → text → both → time。\n• time 只显示昵称 + 时间（如：张三 09:30）\n• text 只显示昵称 + 文案（如：张三 摸鱼中）\n• both 显示昵称 + 文案 + 时间（如：张三 摸鱼中 09:30）"}]},
      tz: {
        group: "🌍 时区管理：",
        aliases: ["timezone"], description: "设置时区、开关时区显示或格式", args: "[时区|list|on|off|format 格式]",
        authorize: saveAuthorize,
        subcommands: {
          list: {description: "查看常用时区列表，方便复制使用", args: "", examples: [{args: "list"}], handle: async (invocation, context) => { await edit(context, invocation, "Asia/Shanghai\nAsia/Tokyo\nEurope/London\nAmerica/New_York"); }},
          on: {description: "开启时区显示", args: "", examples: [{args: "on"}], handle: async (invocation, context) => { const userId = invocation.message.senderId!; await needUser(invocation, context, async () => {await mutate(context, userId, target => {target.show_timezone = true;}); await edit(context, invocation, "✅ 时区显示已开启");}); }},
          off: {description: "关闭时区显示", args: "", examples: [{args: "off"}], handle: async (invocation, context) => { const userId = invocation.message.senderId!; await needUser(invocation, context, async () => {await mutate(context, userId, target => {target.show_timezone = false;}); await edit(context, invocation, "✅ 时区显示已关闭");}); }},
          format: {description: "设置时区的显示格式，可选值：", args: "GMT|UTC|simp|offset|custom:文字", arguments: [{name: "格式", required: true, description: "GMT / UTC / simp / offset / custom:文字"}], examples: [{args: "format GMT"}, {args: "format custom:北京时间"}], help: [{heading: "格式说明：", body: "GMT（默认）：显示 GMT+8；UTC：显示 UTC+8；simp：显示时区缩写，如 HKT / CST / EDT；offset：显示纯偏移量，如 +08:00；custom:文字：自定义显示文字，如 custom:北京时间。"}], handle: async (invocation, context) => {
            const userId = invocation.message.senderId!;
            await needUser(invocation, context, async () => {
              const format = invocation.args.join(" ");
              if (!/^(gmt|utc|simp|offset|custom:.+)$/i.test(format)) { await edit(context, invocation, "❌ 无效的时区格式"); return; }
              await mutate(context, userId, target => {target.timezone_format = format.toUpperCase().startsWith("CUSTOM:") ? `custom:${format.slice(7)}` : format.toUpperCase();});
              await edit(context, invocation, "✅ 时区格式已更新");
            });
          }},
          set: {description: "设置 IANA 时区", args: "时区", arguments: [{name: "时区", required: true, description: "IANA 标识符，如 Asia/Shanghai"}], examples: [{args: "set Asia/Shanghai"}], handle: async (invocation, context) => {
            const userId = invocation.message.senderId!;
            await needUser(invocation, context, async () => {
              const zone = invocation.args.join(" ");
              if (!zone || !validZone(zone)) { await edit(context, invocation, "❌ 无效的时区标识符"); return; }
              await mutate(context, userId, target => {target.timezone = zone;});
              await edit(context, invocation, `✅ 时区已更新为: <code>${escape(zone)}</code>`, true);
            });
          }},
        },
        handle: async (invocation, context) => {
          const userId = invocation.message.senderId!;
          await needUser(invocation, context, async () => {
            const zone = invocation.args.join(" ");
            if (!zone || !validZone(zone)) { await edit(context, invocation, "❌ 无效的时区标识符"); return; }
            await mutate(context, userId, target => {target.timezone = zone;});
            await edit(context, invocation, `✅ 时区已更新为: <code>${escape(zone)}</code>`, true);
          });
        },
        help: [{heading: "时区与格式：", body: "设置您的时区。参数为 IANA 时区标识符，如 Asia/Shanghai（北京）、America/New_York（纽约）、Europe/London（伦敦）等；timezone 等同于 <code>{prefix}acn tz</code>（别名）。\n常用时区：Asia/Shanghai、Asia/Tokyo、Europe/London、America/New_York；也可用 <code>{prefix}acn tz list</code> 查看。\n控制昵称中是否显示时区信息（如 GMT+8）；开启后昵称示例：张三 09:30 GMT+8。\n格式可选：GMT（默认，显示 GMT+8）、UTC（UTC+8）、simp（HKT/CST/EDT 等缩写）、offset（+08:00）、custom:文字（自定义，如 custom:北京时间）。"}],
      },
      text: {
        group: "📝 文案管理：",
        description: "管理系统循环文案", args: "list|clear|add 文案|del 序号|on|off",
        authorize: saveAuthorize,
        subcommands: {
          list: {description: "查看所有文案及序号", args: "", examples: [{args: "list"}], handle: async (invocation, context) => { const state = await store(context).read(); await edit(context, invocation, state.random_texts.length ? state.random_texts.map((text, index) => `${index + 1}. ${escape(text)}`).join("\n") : "📝 无随机文本", true); }},
          clear: {description: "清空所有文案", args: "", examples: [{args: "clear"}], handle: async (invocation, context) => { await store(context).update(current => ({...current, random_texts: []})); await edit(context, invocation, "✅ 所有文本已清空"); }},
          add: {description: "添加文案，支持多行批量添加", args: "文案", arguments: [{name: "文案", description: "每行一条，最长 50 字符，最多 100 条"}], examples: [{args: "add 摸鱼中"}], handle: async (invocation, context) => {
            await needUser(invocation, context, async () => {
              const additions = invocation.message.text.replace(/^\S+\s+text\s+add(?:[ \t]+|\r?\n)?/i, "").split(/\r?\n/).map(value => value.trim()).filter(value => value && value.length <= 50);
              await store(context).update(current => ({...current, random_texts: [...new Set([...current.random_texts, ...additions])].slice(0, 100)}));
              await edit(context, invocation, `✅ 成功添加 ${additions.length} 条`);
            });
          }},
          del: {description: "删除指定序号文案", args: "序号", arguments: [{name: "序号", required: true, description: "从 1 开始"}], examples: [{args: "del 1"}], handle: async (invocation, context) => {
            await needUser(invocation, context, async (state) => {
              const index = Number(invocation.args[0]) - 1;
              if (!Number.isInteger(index) || index < 0 || index >= state.random_texts.length) { await edit(context, invocation, "❌ 无效的索引号"); return; }
              await store(context).update(current => ({...current, random_texts: current.random_texts.filter((_value, currentIndex) => currentIndex !== index)}));
              await edit(context, invocation, "✅ 文本已删除");
            });
          }},
          on: {description: "开启循环文案显示", args: "", examples: [{args: "on"}], handle: async (invocation, context) => { const userId = invocation.message.senderId!; await needUser(invocation, context, async () => { await mutate(context, userId, target => {target.mode = target.show_time === false ? "text" : "both";}); await edit(context, invocation, "✅ 随机文案已开启");}); }},
          off: {description: "关闭循环文案显示", args: "", examples: [{args: "off"}], handle: async (invocation, context) => { const userId = invocation.message.senderId!; await needUser(invocation, context, async () => {await mutate(context, userId, target => {target.mode = "time";}); await edit(context, invocation, "✅ 随机文案已关闭");}); }},
        },
        handle: async (invocation, context) => { await needUser(invocation, context, async () => { await edit(context, invocation, "❌ 未知命令: text"); }); },
        help: [{heading: "说明：", body: "开启或关闭循环文案显示；添加的文案会在 text/both 模式下按添加顺序循环显示。每条文案最长 50 字符，最多保存 100 条；add 支持多行批量添加。"}],
      },
      emoji: {
        group: "🎨 外观设置：",description: "开/关时钟 emoji", args: "on|off", examples: [{args: "emoji on"}], handle: async (invocation, context) => {
        const userId = invocation.message.senderId!;
        await needUser(invocation, context, async () => {
          const enabled = invocation.args[0]?.toLowerCase();
          if (enabled !== "on" && enabled !== "off") { await edit(context, invocation, `请使用 ${invocation.prefix}acn emoji on/off`); return; }
          await mutate(context, userId, target => {target.show_clock_emoji = enabled === "on";});
          await edit(context, invocation, `✅ 时钟Emoji已${enabled === "on" ? "开启" : "关闭"}`);
        });
      }, help: [{heading: "说明：", body: "开启或关闭时钟 emoji（🕐🕑🕒...）；时钟 emoji 会根据当前小时自动匹配对应的钟面。"}]},
      time: {
        group: "🎨 外观设置：",description: "开/关时间显示", args: "on|off", examples: [{args: "time on"}], help: [{heading: "说明：", body: "开启或关闭昵称中的时间显示；时钟 emoji 由 emoji 子命令单独控制。"}], handle: async (invocation, context) => {
        const userId = invocation.message.senderId!;
        await needUser(invocation, context, async () => {
          const enabled = invocation.args[0]?.toLowerCase();
          if (enabled !== "on" && enabled !== "off") { await edit(context, invocation, `请使用 ${invocation.prefix}acn time on/off`); return; }
          await mutate(context, userId, target => {target.show_time = enabled === "on";});
          await edit(context, invocation, `✅ 时间显示已${enabled === "on" ? "开启" : "关闭"}`);
        });
      }},
      order: {
        group: "🎨 外观设置：",description: "查看当前组件的显示顺序，或自定义昵称中各组件的排列顺序", args: "[组件...]", arguments: [{name: "组件", description: "name、text、time、weather、emoji、timezone"}], examples: [{args: "order"}, {args: "order name,text,time,weather,emoji"}], handle: async (invocation, context) => {
        const userId = invocation.message.senderId!;
        await needUser(invocation, context, async (_state, user) => {
          const values = invocation.args.join(" ").split(/[,\s]+/).filter(Boolean);
          const allowed = ["name", "text", "time", "weather", "emoji", "timezone"];
          if (!values.length) { await edit(context, invocation, `当前顺序: <code>${escape(user.display_order || "name,time")}</code>`, true); return; }
          if (values.some(value => !allowed.includes(value))) { await edit(context, invocation, "❌ 无效组件"); return; }
          const order = [...new Set(values)].join(",");
          await mutate(context, userId, target => {target.display_order = order;});
          await edit(context, invocation, `✅ 显示顺序: <code>${order}</code>`, true);
        });
      }},
      style: {
        group: "🎨 外观设置：",description: "切换动态内容文字样式", args: "normal|italic|double|sans|mono|outline", arguments: [{name: "样式", description: "normal / italic / double / sans / mono / outline"}], examples: [{args: "style italic"}], handle: async (invocation, context) => {
        const userId = invocation.message.senderId!;
        await needUser(invocation, context, async () => {
          const style = invocation.args[0]?.toLowerCase();
          if (!["normal", "italic", "double", "sans", "mono", "outline"].includes(style || "")) { await edit(context, invocation, "可用样式: normal, italic, double, sans, mono, outline"); return; }
          await mutate(context, userId, target => {target.text_style = style;});
          await edit(context, invocation, `✅ 文字样式: ${style}`);
        });
      }, help: [{heading: "🎨 文字样式：", body: "切换昵称中动态内容的文字样式。可选：normal（默认）/ italic / double / sans / mono / outline。\n样式效果示例：\nnormal: 123abc\nitalic: 𝟏𝟐𝟑𝐚𝐛𝐜\ndouble: 𝟙𝟚𝟛𝕒𝕓𝕔\nsans: 𝟭𝟮𝟯𝗮𝗯𝗰\nmono: 𝟷𝟸𝟹𝚊𝚋𝚌\noutline: 𝟣𝟤𝟥𝖺𝖻𝖼"}]},
      weather: {
        group: "🌤️ 天气显示：",
        description: "查看或设置天气显示", args: "[on|off|set 地点]",
        authorize: saveAuthorize,
        subcommands: {
          on: {description: "开启天气显示（需先设置地点）", args: "", examples: [{args: "on"}], handle: async (invocation, context) => { const userId = invocation.message.senderId!; await needUser(invocation, context, async (_state, user) => { if (!user.weather_location) { await edit(context, invocation, "❌ 请先设置地点"); return; } await mutate(context, userId, target => {target.weather_enabled = true;}); await edit(context, invocation, "✅ 天气配置已更新"); }); }},
          off: {description: "关闭天气显示", args: "", examples: [{args: "off"}], handle: async (invocation, context) => { const userId = invocation.message.senderId!; await needUser(invocation, context, async () => {await mutate(context, userId, target => {target.weather_enabled = false;}); await edit(context, invocation, "✅ 天气配置已更新");}); }},
          set: {description: "设置天气地点并自动开启", args: "地点", arguments: [{name: "地点", required: true, description: "中文城市名或英文名，如 北京 / Beijing"}], examples: [{args: "set 北京"}, {args: "set Beijing"}], handle: async (invocation, context) => { const userId = invocation.message.senderId!; await needUser(invocation, context, async () => { await mutate(context, userId, target => {target.weather_location = invocation.args.join(" "); target.weather_enabled = true; target.weather_compact = ""; target.weather_cache_ts = 0;}); await edit(context, invocation, "✅ 天气配置已更新"); }); }},
        },
        handle: async (invocation, context) => {
          const userId = invocation.message.senderId!;
          await needUser(invocation, context, async (_state, user) => {
            if (!invocation.args.length) { await edit(context, invocation, `天气: ${user.weather_enabled ? "开" : "关"}\n地点: ${escape(user.weather_location || "未设置")}\n预览: ${escape(user.weather_compact || "暂无缓存")}`, true); return; }
            await mutate(context, userId, target => {target.weather_location = invocation.args.join(" "); target.weather_enabled = true; target.weather_compact = ""; target.weather_cache_ts = 0;});
            await edit(context, invocation, "✅ 天气配置已更新");
          });
        },
        help: [{heading: "说明：", body: "开启或关闭天气显示（需先设置地点）。天气信息缓存 30 分钟；地点支持中文城市名或英文名，如 北京 / Beijing。"}],
      },
      config: {
        group: "📊 查看配置：",description: "查看完整配置状态", args: "", examples: [{args: "config"}], handle: async (invocation, context) => {
        const userId = invocation.message.senderId!;
        await needUser(invocation, context, async (state, user) => {
          const fields = {
            "用户": user.user_id, "自动更新": user.is_enabled ? "开" : "关", "原始姓名": user.original_first_name,
            "原始姓氏": user.original_last_name || "(空)", "模式": user.mode, "时区": user.timezone,
            "时间显示": user.show_time !== false ? "开" : "关", "时钟表情": user.show_clock_emoji ? "开" : "关",
            "时区显示": user.show_timezone ? "开" : "关", "时区格式": user.timezone_format || "GMT",
            "文字样式": user.text_style || "normal", "组件顺序": user.display_order || "name,text,time,weather,emoji,timezone",
            "文案数": state.random_texts.length, "下条文案序号": state.random_texts.length ? user.text_index % state.random_texts.length + 1 : "(空)",
            "天气显示": user.weather_enabled ? "开" : "关", "天气地点": user.weather_location || "未设置",
            "天气预览": user.weather_compact || "暂无缓存", "天气更新时间": user.weather_cache_ts ? new Date(user.weather_cache_ts).toISOString() : "尚未获取",
            "昵称更新时间": user.last_update || "尚未更新",
          };
          await edit(context, invocation, `<b>🔧 您的配置状态</b>\n${Object.entries(fields).map(([label, value]) => `${label}: <code>${escape(String(value))}</code>`).join("\n")}`, true);
        });
      }},
      update: {
        group: "🔧 基础操作：",aliases: ["now"], description: "立即手动更新一次昵称，不等下一分钟", args: "", examples: [{args: "update"}], handle: async (invocation, context) => {
        const userId = invocation.message.senderId!;
        await needUser(invocation, context, async () => {
          const ok = await updateUser(context, userId, true);
          await edit(context, invocation, ok ? "✅ 昵称已手动更新" : "❌ 更新失败");
        });
      }},
      reset: {
        group: "🔧 基础操作：",description: "恢复原始昵称并停止自动更新（不删除配置）", args: "", examples: [{args: "reset"}], handle: async (invocation, context) => {
        const userId = invocation.message.senderId!;
        await needUser(invocation, context, async (_state, user) => {
          await mutate(context, userId, target => {target.is_enabled = false;});
          await context.telegram.withClient(async client => client.invoke(new Api.account.UpdateProfile({firstName: user.original_first_name!, lastName: user.original_last_name || undefined})));
          await edit(context, invocation, "✅ 已恢复原始昵称并禁用自动更新");
        });
      }},
    },
    help: [
      {heading: "📌 快速开始（按顺序执行）：", body: "1️⃣ <code>{prefix}acn save</code> - 保存当前昵称（首次使用必须）\n2️⃣ <code>{prefix}acn on/off</code> - 开启或关闭自动更新\n3️⃣ <code>{prefix}acn mode</code> - 切换显示模式\n4️⃣ 等待一分钟，昵称会自动更新"},
      {heading: "使用技巧：", body: "• 昵称每分钟自动更新一次；启用天气时缓存每半小时刷新一次\n• 文案会按添加顺序循环显示\n• 被限流时会自动停用更新；等待限流结束后使用 <code>{prefix}acn on</code> 重新启用"},
      {heading: "遇到问题：", body: "• 使用 <code>{prefix}acn status</code> 检查运行状态\n• 使用 <code>{prefix}acn reset</code> 恢复原始昵称并停止自动更新\n• 重新执行 <code>{prefix}acn save</code> 保存昵称"},
      {heading: "命令别名：", body: "<code>{prefix}autochangename</code> 与 <code>{prefix}acn</code> 使用相同参数。"},
    ],
    async handle(invocation, context) {
      const sub = invocation.args[0]?.toLowerCase();
      if (!sub || sub === "help" || sub === "h") {
        await edit(context, invocation, renderAcnHelp(invocation.prefix), true);
        return;
      }
      await needUser(invocation, context, async () => { await edit(context, invocation, `❌ 未知命令: <code>${escape(sub)}</code>`, true); });
    },
  };
  const renderAcnHelp = (prefix: string): string => renderCommandHelp("acn", acnCommand, {prefix, title: "🤖 自动昵称更新插件 v3",
    intro: "让您的昵称动起来！自动显示时间或个性文案 ⏰"});
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "autochangename", description: "按时区自动更新账号昵称",
    renderHelp: renderAcnHelp,
    commands: {acn: acnCommand, autochangename: {...acnCommand}},
    jobs: {update_names: {cron: "0 * * * * *", timeZone: "Asia/Shanghai", description: "每分钟更新已启用昵称", async handle(context) { const state = await store(context).read(); for (const id of Object.keys(state.users).filter(id => state.users[id].is_enabled)) { context.signal.throwIfAborted(); await updateUser(context, id); } }}},
    async setup(context) { await store(context).update(state => ({...state, schemaVersion: 1,
      users: Object.fromEntries(Object.entries(state.users || {}).map(([id, user]) => [id, {...user, user_id: String(user.user_id ?? id), timezone: validZone(user.timezone) ? user.timezone : "Asia/Shanghai"}])),
      random_texts: Array.isArray(state.random_texts) ? state.random_texts.filter((text): text is string => typeof text === "string").slice(0, 100) : []})); },
  });
}
