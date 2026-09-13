import {renderHelp as renderPluginHelp} from "./v2/help";
import {Api} from "teleproto";
import {
  STRUCTURED_PLUGIN_API_VERSION,
  definePlugin,
  type CommandDefinition,
  type CommandInvocation,
  type PluginContext,
  type PluginDefinition,
  type SubcommandDefinition,
} from "telebox/sdk";
import {NameAppearance} from "./v2/appearance";
import {weatherCity, weatherEmoji} from "./v2/weather";

const appearance = new NameAppearance();
const COMPONENTS = ["name", "text", "time", "weather", "emoji", "timezone"] as const;
const STYLES = ["normal", "italic", "double", "sans", "mono", "outline"] as const;

type Mode = "time" | "text" | "both";
type TextStyle = typeof STYLES[number];
interface UserSettings {
  user_id: string;
  timezone: string;
  original_first_name: string | null;
  original_last_name: string | null;
  is_enabled: boolean;
  mode: Mode;
  last_update: string | null;
  text_index: number;
  show_clock_emoji?: boolean;
  show_time?: boolean;
  hour_format?: "12" | "24";
  show_timezone?: boolean;
  timezone_format?: string;
  display_order?: string;
  displayComponents?: string[];
  text_style?: TextStyle;
  weather_enabled?: boolean;
  weather_location?: string;
  weather_compact?: string;
  weather_cache_ts?: number;
}
interface State extends Record<string, unknown> {
  schemaVersion: number;
  users: Record<string, UserSettings>;
  random_texts: string[];
}

const defaults: State = {schemaVersion: 1, users: {}, random_texts: []};
const escape = (value: string): string => value.replace(/[&<>"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[character]!);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validZone = (zone: unknown): zone is string => {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en", {timeZone: zone}).format();
    return true;
  } catch {
    return false;
  }
};
const validMode = (value: unknown): value is Mode => value === "time" || value === "text" || value === "both";
const validStyle = (value: unknown): value is TextStyle => typeof value === "string" && STYLES.includes(value as TextStyle);
const time = (zone: string, format: "12" | "24" = "24"): string => new Intl.DateTimeFormat(format === "12" ? "en-US" : "zh-CN", {
  timeZone: zone,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: format === "12" ? "h12" : "h23",
}).format(new Date());
const cleanName = (name: string): string => name.slice(0, 128)
  .replace(/\b\d{1,2}:\d{2}(\s?(AM|PM))?\b/gi, "")
  .replace(/[\u{1F550}-\u{1F567}]/gu, "")
  .replace(/\s+/g, " ")
  .trim();
const clock = (zone: string): string => {
  const hour = Number(new Intl.DateTimeFormat("en", {timeZone: zone, hour: "numeric", hourCycle: "h23"}).format(new Date())) % 12;
  return String.fromCodePoint(0x1f550 + (hour + 11) % 12);
};

function newUser(userId: string): UserSettings {
  return {
    user_id: userId,
    timezone: "Asia/Shanghai",
    original_first_name: null,
    original_last_name: null,
    is_enabled: false,
    mode: "time",
    last_update: null,
    text_index: 0,
    show_clock_emoji: false,
    show_time: true,
    hour_format: "24",
    show_timezone: false,
    timezone_format: "GMT",
    display_order: "name,time",
    weather_enabled: false,
    weather_location: "",
    weather_compact: "",
    weather_cache_ts: 0,
    text_style: "normal",
  };
}

function normalizeUser(userId: string, value: unknown): UserSettings {
  const source = isRecord(value) ? value : {};
  const originalFirst = typeof source.original_first_name === "string" ? source.original_first_name : null;
  const originalLast = typeof source.original_last_name === "string" && source.original_last_name ? source.original_last_name : null;
  const components = Array.isArray(source.displayComponents)
    ? [...new Set(source.displayComponents.filter((entry): entry is string => typeof entry === "string" && COMPONENTS.includes(entry as typeof COMPONENTS[number])))]
    : undefined;
  const normalized = {
    ...newUser(userId),
    ...source,
    user_id: userId,
    timezone: validZone(source.timezone) ? source.timezone : "Asia/Shanghai",
    original_first_name: originalFirst,
    original_last_name: originalLast,
    is_enabled: Boolean(source.is_enabled && originalFirst),
    mode: validMode(source.mode) ? source.mode : "time",
    last_update: typeof source.last_update === "string" ? source.last_update : null,
    text_index: Number.isInteger(source.text_index) && Number(source.text_index) >= 0 ? Number(source.text_index) : 0,
    hour_format: source.hour_format === "12" ? "12" : "24",
    text_style: validStyle(source.text_style) ? source.text_style : "normal",
  } as UserSettings;
  if (components) normalized.displayComponents = components;
  else delete normalized.displayComponents;
  return normalized;
}

function normalizeState(state: State): State {
  const rawUsers = isRecord(state.users) ? state.users : {};
  return {
    ...state,
    schemaVersion: 1,
    users: Object.fromEntries(Object.entries(rawUsers).map(([id, user]) => [id, normalizeUser(id, user)])),
    random_texts: Array.isArray(state.random_texts)
      ? state.random_texts.filter((entry): entry is string => typeof entry === "string").slice(0, 100)
      : [],
  };
}

async function weather(context: PluginContext, user: UserSettings, includeDisabled = false): Promise<{text: string; fetchedAt?: number}> {
  if ((!includeDisabled && !user.weather_enabled) || !user.weather_location) return {text: ""};
  if (user.weather_cache_ts && Date.now() - user.weather_cache_ts < (user.weather_compact ? 1_800_000 : 300_000)) {
    return {text: user.weather_compact || ""};
  }
  try {
    const geo = await context.http.json<any>(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(weatherCity(user.weather_location))}&count=1&language=zh&format=json`,
      {}, {timeoutMs: 10_000, redirects: {allowedHosts: ["geocoding-api.open-meteo.com"], maxRedirects: 2}},
    );
    const location = geo?.results?.[0];
    if (!location || typeof location.latitude !== "number" || typeof location.longitude !== "number") {
      return {text: "", fetchedAt: Date.now()};
    }
    const forecast = await context.http.json<any>(
      `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,weather_code&timezone=auto`,
      {}, {timeoutMs: 10_000, redirects: {allowedHosts: ["api.open-meteo.com"], maxRedirects: 2}},
    );
    const current = forecast?.current;
    if (!current || typeof current.temperature_2m !== "number" || typeof current.weather_code !== "number") {
      return {text: "", fetchedAt: Date.now()};
    }
    return {text: `${weatherEmoji(current.weather_code)} ${Math.round(current.temperature_2m)}°C`, fetchedAt: Date.now()};
  } catch {
    context.signal.throwIfAborted();
    return {text: "", fetchedAt: Date.now()};
  }
}

async function updateUser(context: PluginContext, userId: string, force = false): Promise<boolean> {
  const store = context.storage.json<State>("autochangename.json", defaults);
  const state = await store.read();
  const user = state.users[userId];
  if (!user || (!force && !user.is_enabled) || !user.original_first_name) return false;
  if (!force && user.last_update && Date.now() - Date.parse(user.last_update) < 30_000) return false;

  const selected = Array.isArray(user.displayComponents) && user.displayComponents.length
    ? new Set(user.displayComponents)
    : undefined;
  const includes = (component: string): boolean => !selected || selected.has(component);
  const texts = state.random_texts;
  const components: Record<string, string> = {
    name: user.original_first_name,
    text: "",
    time: "",
    emoji: "",
    timezone: "",
    weather: "",
  };
  if (((user.mode === "text" || user.mode === "both") || selected?.has("text")) && includes("text") && texts.length) {
    components.text = texts[user.text_index % texts.length] ?? "";
  }
  if (user.show_time !== false && includes("time")) {
    components.time = time(user.timezone, user.hour_format);
  }
  if (user.show_clock_emoji) components.emoji = clock(user.timezone);
  if (user.show_timezone) components.timezone = appearance.timezoneLabel(user.timezone, user.timezone_format);
  const currentWeather = await weather(context, user);
  components.weather = currentWeather.text;

  const requested = (user.display_order || "name,time").split(",").map(value => value.trim()).filter(Boolean);
  const pieces = [...new Set([...requested, ...COMPONENTS])].map(key => {
    const value = components[key] || "";
    return key === "name" ? value : appearance.applyTextStyle(value, user.text_style);
  }).filter(Boolean);
  const firstName = Array.from(pieces.join(" ")).slice(0, 64).join("");

  try {
    await context.telegram.withClient(async (client, signal) => {
      signal.throwIfAborted();
      await client.invoke(new Api.account.UpdateProfile({
        firstName,
        lastName: user.original_last_name || undefined,
      }));
    });
    await store.update(current => {
      const next = current.users[userId];
      if (next) {
        next.last_update = new Date().toISOString();
        if (currentWeather.fetchedAt !== undefined) {
          next.weather_compact = currentWeather.text;
          next.weather_cache_ts = currentWeather.fetchedAt;
        }
        if (texts.length && next.mode !== "time") next.text_index = (next.text_index + 1) % texts.length;
      }
      return {...current, schemaVersion: 1};
    });
    return true;
  } catch (error) {
    if (context.signal.aborted) return false;
    const message = error instanceof Error ? error.message : "";
    if (message.includes("FLOOD_WAIT")) {
      await store.update(current => {
        if (current.users[userId]) current.users[userId].is_enabled = false;
        return current;
      });
      context.log.error("autochangename_profile_flood_wait");
    } else if (message.includes("USERNAME_NOT_MODIFIED")) {
      return true;
    } else {
      context.log.error("autochangename_profile_update_failed");
    }
    return false;
  }
}

type Handler = SubcommandDefinition["handle"];

function protect(handler: Handler): Handler {
  return async (invocation, context) => {
    try {
      await handler(invocation, context);
    } catch (error) {
      if (context.signal.aborted) return;
      const message = error instanceof Error ? error.message : "";
      if (message.includes("MESSAGE_ID_INVALID")) return;
      context.log.error("autochangename_command_failed");
      if (message.includes("FLOOD_WAIT")) {
        const wait = message.match(/\d+/)?.[0] ?? "60";
        await context.telegram.edit(invocation.message, `⏳ <b>请求过于频繁</b>\n\n需要等待 ${wait} 秒后重试`, {parseMode: "html"});
        return;
      }
      await context.telegram.edit(invocation.message, "❌ <b>操作失败，请稍后重试</b>", {parseMode: "html"});
    }
  };
}

function protectSubcommand(definition: SubcommandDefinition): SubcommandDefinition {
  const subcommands = definition.subcommands
    ? Object.fromEntries(Object.entries(definition.subcommands).map(([name, child]) => [name, protectSubcommand(child)]))
    : undefined;
  return {
    ...definition,
    ...(subcommands ? {subcommands} : {}),
    handle: protect(definition.handle),
  };
}

function protectCommand(definition: CommandDefinition): CommandDefinition {
  const subcommands = definition.subcommands
    ? Object.fromEntries(Object.entries(definition.subcommands).map(([name, child]) => [name, protectSubcommand(child)]))
    : undefined;
  return {
    ...definition,
    ...(subcommands ? {subcommands} : {}),
    handle: protect(definition.handle),
  };
}

export default function createAutoChangeName(): PluginDefinition {
  let jobRunning = false;
  const store = (context: PluginContext) => context.storage.json<State>("autochangename.json", defaults);
  const edit = (context: PluginContext, invocation: CommandInvocation, text: string, html = false) =>
    context.telegram.edit(invocation.message, text, html ? {parseMode: "html", linkPreview: false} : {});
  const usage = (invocation: CommandInvocation, tail = ""): string =>
    `${escape(invocation.prefix)}acn${tail ? ` ${tail}` : ""}`;
  const mutate = async (context: PluginContext, userId: string, transform: (user: UserSettings) => void): Promise<UserSettings | undefined> => {
    let result: UserSettings | undefined;
    await store(context).update(current => {
      const target = current.users[userId];
      if (!target) return current;
      transform(target);
      result = {...target, ...(target.displayComponents ? {displayComponents: [...target.displayComponents]} : {})};
      return current;
    });
    return result;
  };
  const needUser = async (
    invocation: CommandInvocation,
    context: PluginContext,
    run: (state: State, user: UserSettings, userId: string) => Promise<void>,
  ): Promise<void> => {
    const userId = invocation.message.senderId ?? "";
    const state = await store(context).read();
    const user = state.users[userId];
    if (!user?.original_first_name) {
      await edit(context, invocation, `❌ 请先 <code>${usage(invocation, "save")}</code>`, true);
      return;
    }
    await run(state, user, userId);
  };
  const refreshIfEnabled = async (context: PluginContext, userId: string, user: UserSettings | undefined): Promise<void> => {
    if (user?.is_enabled) await updateUser(context, userId, true);
  };
  const updateOrderComponent = (user: UserSettings, component: string, enabled: boolean): void => {
    const order = (user.display_order || "name,time").split(",").map(value => value.trim()).filter(Boolean);
    const index = order.indexOf(component);
    if (enabled && index < 0) order.push(component);
    if (!enabled && index >= 0) order.splice(index, 1);
    user.display_order = order.join(",");
  };
  const setTimezone = async (invocation: CommandInvocation, context: PluginContext, zone: string): Promise<void> => {
    await needUser(invocation, context, async (_state, _user, userId) => {
      if (!validZone(zone)) {
        await edit(context, invocation, "❌ 无效的时区标识符");
        return;
      }
      const updated = await mutate(context, userId, target => { target.timezone = zone; });
      await refreshIfEnabled(context, userId, updated);
      await edit(context, invocation, `✅ 时区已更新为: <code>${escape(zone)}</code>`, true);
    });
  };
  const setTimezoneDisplay = async (invocation: CommandInvocation, context: PluginContext, enabled: boolean): Promise<void> => {
    await needUser(invocation, context, async (_state, _user, userId) => {
      const updated = await mutate(context, userId, target => {
        target.show_timezone = enabled;
        updateOrderComponent(target, "timezone", enabled);
      });
      await refreshIfEnabled(context, userId, updated);
      await edit(context, invocation, `✅ 时区显示已${enabled ? "开启" : "关闭"}`);
    });
  };
  const setWeather = async (invocation: CommandInvocation, context: PluginContext, action: "on" | "off" | "set", location = ""): Promise<void> => {
    await needUser(invocation, context, async (_state, user, userId) => {
      if (action === "on" && !user.weather_location) {
        await edit(context, invocation, "❌ 请先设置地点");
        return;
      }
      const updated = await mutate(context, userId, target => {
        if (action === "set") {
          target.weather_location = location;
          target.weather_enabled = true;
          target.weather_compact = "";
          target.weather_cache_ts = 0;
        } else {
          target.weather_enabled = action === "on";
        }
        updateOrderComponent(target, "weather", target.weather_enabled === true);
      });
      await refreshIfEnabled(context, userId, updated);
      await edit(context, invocation, "✅ 天气配置已更新");
    });
  };

  const rawCommand: CommandDefinition = {
    description: "管理动态昵称",
    helpArgs: ["help", "h"],
    helpOnEmpty: true,
    args: "子命令",
    arguments: [{name: "子命令", description: "save/on/off/mode/tz/text/show/time/emoji/order/style/weather/config/update/reset/status"}],
    subcommandsCaseSensitive: false,
    authorize: async (invocation, context) => {
      const raw = invocation.message.raw as {fromId?: {className?: string}} | undefined;
      if (invocation.message.chatType === "broadcast" || raw?.fromId?.className === "PeerChannel") {
        await edit(context, invocation, "⚠️ <b>不支持在频道中使用此命令</b>\n\n请在私聊中发送命令来管理动态昵称。", true);
        return false;
      }
      if (!invocation.message.senderId) {
        await edit(context, invocation, "❌ <b>无法识别您的身份</b>\n\n请确保在私聊中使用此命令。", true);
        return false;
      }
      return true;
    },
    subcommands: {
      save: {
        description: "保存当前昵称为原始基准",
        async handle(invocation, context) {
          const userId = invocation.message.senderId!;
          await edit(context, invocation, "⏳ 正在保存当前昵称...", true);
          const profile = await context.telegram.withClient(async (client, signal) => {
            signal.throwIfAborted();
            return client.getMe();
          });
          let firstSave = true;
          const state = await store(context).update(current => {
            const old = current.users[userId];
            firstSave = !old?.last_update;
            current.users[userId] = {
              ...newUser(userId),
              ...old,
              user_id: userId,
              timezone: validZone(old?.timezone) ? old.timezone : "Asia/Shanghai",
              original_first_name: cleanName(profile.firstName || ""),
              original_last_name: cleanName(profile.lastName || "") || null,
              is_enabled: old?.is_enabled ?? false,
              mode: validMode(old?.mode) ? old.mode : "time",
              last_update: old?.last_update ?? null,
              text_index: Number.isInteger(old?.text_index) && old!.text_index >= 0 ? old!.text_index : 0,
              hour_format: old?.hour_format === "12" ? "12" : "24",
            };
            return {...current, schemaVersion: 1};
          });
          const saved = state.users[userId]!;
          if (firstSave) {
            await edit(context, invocation,
              `🎉 <b>昵称保存成功！</b>\n\n<b>✅ 已保存的原始昵称：</b>\n• 姓名: <code>${escape(saved.original_first_name || "")}</code>\n• 姓氏: <code>${escape(saved.original_last_name || "(空)")}</code>\n\n<b>🚀 接下来您可以：</b>\n<code>${usage(invocation, "on/off")}</code> - 开启或关闭自动昵称更新`, true);
          } else {
            await edit(context, invocation,
              `✅ <b>原始昵称已更新</b>（其它配置保留）\n\n<b>姓名:</b> <code>${escape(saved.original_first_name || "")}</code>\n<b>姓氏:</b> <code>${escape(saved.original_last_name || "(空)")}</code>\n\n天气/样式/顺序/开关等设置不会被 save 清空。`, true);
          }
        },
      },
      on: {
        aliases: ["enable"],
        description: "开启自动更新",
        async handle(invocation, context) {
          await needUser(invocation, context, async (_state, _user, userId) => {
            const updated = await mutate(context, userId, target => { target.is_enabled = true; });
            await updateUser(context, userId, true);
            await edit(context, invocation,
              `✅ <b>动态昵称已启用</b>\n\n🕐 当前时区: <code>${escape(updated?.timezone || "Asia/Shanghai")}</code>\n📝 显示模式: <code>${updated?.mode || "time"}</code>\n⏰ 更新频率: 每分钟`, true);
          });
        },
      },
      off: {
        aliases: ["disable"],
        description: "关闭自动更新并恢复原始昵称",
        async handle(invocation, context) {
          await needUser(invocation, context, async (_state, user, userId) => {
            await mutate(context, userId, target => { target.is_enabled = false; });
            await context.telegram.withClient(async (client, signal) => {
              signal.throwIfAborted();
              await client.invoke(new Api.account.UpdateProfile({
                firstName: user.original_first_name || "",
                lastName: user.original_last_name || undefined,
              }));
            });
            await edit(context, invocation, "✅ <b>动态昵称已禁用</b>\n已恢复原始昵称", true);
          });
        },
      },
      status: {
        description: "查看自动任务和启用人数",
        async handle(invocation, context) {
          const state = await store(context).read();
          const enabled = Object.values(state.users).filter(user => user.is_enabled).length;
          await edit(context, invocation,
            `📊 <b>动态昵称状态</b>\n\n🔄 自动更新: <code>${enabled ? "运行中" : "已停止"}</code>\n👥 启用用户: <code>${enabled}</code>`, true);
        },
      },
      mode: {
        description: "循环切换 time、text、both",
        async handle(invocation, context) {
          await needUser(invocation, context, async (_state, _user, userId) => {
            const next: Record<Mode, Mode> = {time: "text", text: "both", both: "time"};
            const updated = await mutate(context, userId, target => { target.mode = next[target.mode]; });
            await refreshIfEnabled(context, userId, updated);
            await edit(context, invocation, `✅ <b>显示模式已切换</b>\n\n📝 当前模式: <code>${updated?.mode || ""}</code>`, true);
          });
        },
      },
      tz: {
        aliases: ["timezone"],
        description: "设置时区、显示与格式",
        subcommands: {
          list: {description: "查看常用时区", async handle(invocation, context) {
            await needUser(invocation, context, async () => {
              await edit(context, invocation, "🌍 <b>常用时区列表</b>\n\nAsia/Shanghai\nAsia/Tokyo\nEurope/London\nAmerica/New_York", true);
            });
          }},
          on: {description: "开启时区显示", async handle(invocation, context) { await setTimezoneDisplay(invocation, context, true); }},
          off: {description: "关闭时区显示", async handle(invocation, context) { await setTimezoneDisplay(invocation, context, false); }},
          format: {description: "设置或查看时区格式", args: "[GMT|UTC|simp|offset|custom:文字]", async handle(invocation, context) {
            await needUser(invocation, context, async (_state, user, userId) => {
              const format = invocation.args.join(" ");
              if (!format) {
                await edit(context, invocation,
                  `🌐 <b>时区格式设置</b>\n当前: <code>${escape(user.timezone_format || "GMT")}</code>\n可用: GMT, UTC, simp, offset, custom:文本`, true);
                return;
              }
              if (!/^(gmt|utc|simp|offset|custom:.+)$/i.test(format)) {
                await edit(context, invocation, "❌ 无效的时区格式");
                return;
              }
              const updated = await mutate(context, userId, target => {
                target.timezone_format = format.toLowerCase().startsWith("custom:") ? `custom:${format.slice(7)}` : format.toUpperCase();
              });
              await refreshIfEnabled(context, userId, updated);
              await edit(context, invocation, `✅ <b>时区格式已更新为:</b> <code>${escape(updated?.timezone_format || "")}</code>`, true);
            });
          }},
          set: {description: "设置 IANA 时区", args: "时区", async handle(invocation, context) {
            await setTimezone(invocation, context, invocation.args.join(" "));
          }},
        },
        async handle(invocation, context) {
          if (!invocation.args.length) {
            await needUser(invocation, context, async () => {
              await edit(context, invocation,
                `🌍 <b>时区管理</b>\n\n• <code>${usage(invocation, "tz Asia/Shanghai")}</code> - 设置时区\n• <code>${usage(invocation, "tz list")}</code> - 时区列表\n• <code>${usage(invocation, "tz on/off")}</code> - 显示控制\n• <code>${usage(invocation, "tz format GMT")}</code> - 格式设置`, true);
            });
            return;
          }
          await setTimezone(invocation, context, invocation.args.join(" "));
        },
      },
      text: {
        description: "管理循环文案",
        subcommands: {
          list: {description: "列出文案", async handle(invocation, context) {
            await needUser(invocation, context, async (state) => {
              const body = state.random_texts.length
                ? `📝 <b>随机文本列表</b>\n\n${state.random_texts.map((value, index) => `${index + 1}. ${escape(value)}`).join("\n")}\n\n📊 总数量: ${state.random_texts.length}`
                : `📝 <b>无随机文本</b>\n使用 <code>${usage(invocation, "text add 文本")}</code> 添加`;
              await edit(context, invocation, body, true);
            });
          }},
          clear: {description: "清空文案", async handle(invocation, context) {
            await needUser(invocation, context, async () => {
              await store(context).update(current => ({...current, random_texts: []}));
              await edit(context, invocation, "✅ 所有文本已清空");
            });
          }},
          add: {description: "添加一条或多行文案", args: "文案", async handle(invocation, context) {
            await needUser(invocation, context, async (state) => {
              const input = invocation.message.text.replace(/^\S+\s+text\s+add(?:[ \t]+|\r?\n)?/i, "");
              if (!input.trim()) {
                await edit(context, invocation, "❌ 请提供要添加的文本内容");
                return;
              }
              const candidates = input.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
              const valid: string[] = [];
              const duplicate: string[] = [];
              const invalid: string[] = [];
              for (const candidate of candidates) {
                if (candidate.length > 50) invalid.push(candidate);
                else if (state.random_texts.includes(candidate) || valid.includes(candidate)) duplicate.push(candidate);
                else valid.push(candidate);
              }
              const capacity = Math.max(0, 100 - state.random_texts.length);
              const accepted = valid.slice(0, capacity);
              await store(context).update(current => ({...current, random_texts: [...current.random_texts, ...accepted]}));
              let response = "✅ <b>文本添加结果</b>\n\n";
              if (accepted.length) response += `✅ 成功添加 ${accepted.length} 条\n`;
              if (duplicate.length) response += `⚠️ 跳过 ${duplicate.length} 条重复\n`;
              if (invalid.length || valid.length > accepted.length) response += `❌ 跳过 ${invalid.length + valid.length - accepted.length} 条超长或超出上限\n`;
              response += `\n📊 当前总数: ${state.random_texts.length + accepted.length}`;
              await edit(context, invocation, response, true);
            });
          }},
          del: {description: "按序号删除文案", args: "序号", async handle(invocation, context) {
            await needUser(invocation, context, async (state) => {
              const index = Number(invocation.args[0]) - 1;
              if (!Number.isInteger(index) || index < 0 || index >= state.random_texts.length) {
                await edit(context, invocation, "❌ 无效的索引号");
                return;
              }
              await store(context).update(current => ({...current, random_texts: current.random_texts.filter((_value, at) => at !== index)}));
              await edit(context, invocation, `✅ <b>文本已删除</b>\n📊 剩余数量: ${state.random_texts.length - 1}`, true);
            });
          }},
          on: {description: "开启文案显示", async handle(invocation, context) {
            await needUser(invocation, context, async (_state, user, userId) => {
              const updated = await mutate(context, userId, target => {
                target.mode = target.show_time === false ? "text" : "both";
                if (target.displayComponents && !target.displayComponents.includes("text")) target.displayComponents.push("text");
                updateOrderComponent(target, "text", true);
              });
              await refreshIfEnabled(context, userId, updated);
              await edit(context, invocation, `✅ <b>随机文案已开启</b>\n模式: <code>${updated?.mode || user.mode}</code>`, true);
            });
          }},
          off: {description: "关闭文案显示", async handle(invocation, context) {
            await needUser(invocation, context, async (_state, _user, userId) => {
              const updated = await mutate(context, userId, target => {
                target.mode = "time";
                if (target.displayComponents) target.displayComponents = target.displayComponents.filter(component => component !== "text");
                updateOrderComponent(target, "text", false);
              });
              await refreshIfEnabled(context, userId, updated);
              await edit(context, invocation, "✅ <b>随机文案已关闭</b>", true);
            });
          }},
        },
        async handle(invocation, context) {
          await needUser(invocation, context, async () => {
            await edit(context, invocation, "❌ <b>命令格式错误</b>\n请使用 add, del, list, clear, on, off", true);
          });
        },
      },
      time: {
        description: "设置时间显示和 12/24 小时制",
        args: "[on|off|12|24|format 12|24]",
        async handle(invocation, context) {
          await needUser(invocation, context, async (_state, user, userId) => {
            const action = invocation.args[0]?.toLowerCase();
            if (!action) {
              await edit(context, invocation,
                `<b>时间显示</b>\n当前: <code>${user.show_time !== false ? "开启" : "关闭"}</code>\n时间制式: <code>${user.hour_format === "12" ? "12" : "24"} 小时制</code>\n使用 <code>${usage(invocation, "time on/off")}</code> 或 <code>${usage(invocation, "time 12/24")}</code>`, true);
              return;
            }
            const rawFormat = action === "format" ? invocation.args[1]?.toLowerCase() : action;
            const format = rawFormat?.replace(/h$/, "");
            if (format === "12" || format === "24") {
              const updated = await mutate(context, userId, target => { target.hour_format = format; });
              await refreshIfEnabled(context, userId, updated);
              await edit(context, invocation, `✅ 已切换为 ${format} 小时制${format === "12" ? "（如 02:32 AM）" : "（如 14:32）"}`);
              return;
            }
            if (action !== "on" && action !== "off") {
              await edit(context, invocation, `请使用 ${invocation.prefix}acn time on/off 或 ${invocation.prefix}acn time 12/24`);
              return;
            }
            const enabled = action === "on";
            const updated = await mutate(context, userId, target => {
              target.show_time = enabled;
              updateOrderComponent(target, "time", enabled);
            });
            await refreshIfEnabled(context, userId, updated);
            await edit(context, invocation, `✅ 时间显示已${enabled ? "开启" : "关闭"}`);
          });
        },
      },
      emoji: {
        description: "设置时钟 emoji",
        args: "[on|off]",
        async handle(invocation, context) {
          await needUser(invocation, context, async (_state, user, userId) => {
            const action = invocation.args[0]?.toLowerCase();
            if (!action) {
              await edit(context, invocation,
                `<b>时钟Emoji</b>\n当前: <code>${user.show_clock_emoji ? "开启" : "关闭"}</code>\n使用 <code>${usage(invocation, "emoji on/off")}</code> 切换`, true);
              return;
            }
            if (action !== "on" && action !== "off") {
              await edit(context, invocation, `请使用 ${invocation.prefix}acn emoji on/off`);
              return;
            }
            const enabled = action === "on";
            const updated = await mutate(context, userId, target => {
              target.show_clock_emoji = enabled;
              updateOrderComponent(target, "emoji", enabled);
            });
            await refreshIfEnabled(context, userId, updated);
            await edit(context, invocation, `✅ 时钟Emoji已${enabled ? "开启" : "关闭"}`);
          });
        },
      },
      order: {
        description: "查看或设置组件顺序",
        args: "[name,text,time,weather,emoji,timezone]",
        async handle(invocation, context) {
          await needUser(invocation, context, async (_state, user, userId) => {
            const values = invocation.args.join(" ").toLowerCase().split(/[,\s]+/).filter(Boolean);
            if (!values.length) {
              await edit(context, invocation,
                `📋 <b>当前显示顺序</b>\n<code>${escape(user.display_order || "默认")}</code>\n使用 <code>${usage(invocation, "order time,name,weather...")}</code> 调整`, true);
              return;
            }
            const invalid = values.filter(value => !COMPONENTS.includes(value as typeof COMPONENTS[number]));
            if (invalid.length) {
              await edit(context, invocation,
                `❌ 无效组件: <code>${escape(invalid.join(", "))}</code>\n可用: ${COMPONENTS.join(", ")}`, true);
              return;
            }
            const order = [...new Set(values)].join(",");
            const updated = await mutate(context, userId, target => {
              target.display_order = order;
              target.show_time = values.includes("time");
              target.show_clock_emoji = values.includes("emoji");
              target.show_timezone = values.includes("timezone");
              if (values.includes("weather")) target.weather_enabled = true;
            });
            await refreshIfEnabled(context, userId, updated);
            await edit(context, invocation, `✅ <b>显示顺序已更新为:</b>\n<code>${order}</code>`, true);
          });
        },
      },
      style: {
        description: "设置动态内容样式",
        args: "[normal|italic|double|sans|mono|outline]",
        async handle(invocation, context) {
          await needUser(invocation, context, async (_state, _user, userId) => {
            const style = invocation.args[0]?.toLowerCase();
            if (!validStyle(style)) {
              await edit(context, invocation, "🎨 <b>文字样式</b>\n可用: normal, italic, double, sans, mono, outline", true);
              return;
            }
            const updated = await mutate(context, userId, target => { target.text_style = style; });
            await refreshIfEnabled(context, userId, updated);
            await edit(context, invocation, `✅ <b>文字样式已更新为:</b> <code>${style}</code>`, true);
          });
        },
      },
      show: {
        description: "查询、重置或开关显示组件",
        args: "[reset|time|text|weather on|off]",
        async handle(invocation, context) {
          await needUser(invocation, context, async (_state, user, userId) => {
            const defaultsByMode: Record<Mode, string[]> = {
              time: ["time"],
              text: ["text", "time"],
              both: ["text", "time"],
            };
            const action = invocation.args[0]?.toLowerCase();
            const target = invocation.args[1]?.toLowerCase();
            if (!action || action === "help" || action === "h") {
              const current = user.displayComponents || defaultsByMode[user.mode];
              await edit(context, invocation,
                `🎛️ <b>显示组件管理</b>\n\n当前组件: <code>${current.join(", ")}</code>\n\n• <code>${usage(invocation, "show time on/off")}</code>\n• <code>${usage(invocation, "show text on/off")}</code>\n• <code>${usage(invocation, "show weather on/off")}</code>\n• <code>${usage(invocation, "show reset")}</code>`, true);
              return;
            }
            if (action === "reset") {
              const updated = await mutate(context, userId, setting => {
                setting.displayComponents = [...defaultsByMode[setting.mode]];
              });
              await refreshIfEnabled(context, userId, updated);
              await edit(context, invocation,
                `✅ <b>已重置为默认值</b>\n\n当前模式默认组件: <code>${updated?.displayComponents?.join(", ") || ""}</code>`, true);
              return;
            }
            if (!(["time", "text", "weather"] as string[]).includes(action)) {
              await edit(context, invocation, "❌ <b>acn show 仅支持管理 time/text/weather</b>", true);
              return;
            }
            if (target !== "on" && target !== "off") {
              await edit(context, invocation, `❌ <b>请指定 on 或 off</b>\n使用: <code>${usage(invocation, `show ${action} on/off`)}</code>`, true);
              return;
            }
            if (action === "weather" && target === "on" && !user.weather_location?.trim()) {
              await edit(context, invocation,
                `❌ <b>请先设置天气地点</b>\n使用 <code>${usage(invocation, "weather set 北京")}</code>`, true);
              return;
            }
            const updated = await mutate(context, userId, setting => {
              const current = setting.displayComponents
                ? [...setting.displayComponents]
                : [...defaultsByMode[setting.mode]];
              if (target === "on" && !current.includes(action)) current.push(action);
              if (target === "off") setting.displayComponents = current.filter(component => component !== action);
              else setting.displayComponents = current;
              if (action === "weather") setting.weather_enabled = target === "on";
            });
            await refreshIfEnabled(context, userId, updated);
            await edit(context, invocation,
              `✅ <b>组件已${target === "on" ? "开启" : "关闭"}</b>\n当前组件: <code>${updated?.displayComponents?.join(", ") || ""}</code>`, true);
          });
        },
      },
      weather: {
        description: "查询或设置天气",
        subcommands: {
          on: {description: "开启天气", async handle(invocation, context) { await setWeather(invocation, context, "on"); }},
          off: {description: "关闭天气", async handle(invocation, context) { await setWeather(invocation, context, "off"); }},
          set: {description: "设置地点", args: "地点", async handle(invocation, context) {
            await setWeather(invocation, context, "set", invocation.args.join(" ").trim());
          }},
        },
        async handle(invocation, context) {
          await needUser(invocation, context, async (_state, user, userId) => {
            if (!invocation.args.length || invocation.args[0]?.toLowerCase() === "help") {
              const preview = await weather(context, user, true);
              if (preview.fetchedAt !== undefined) {
                await mutate(context, userId, target => {
                  target.weather_compact = preview.text;
                  target.weather_cache_ts = preview.fetchedAt;
                });
              }
              await edit(context, invocation,
                `🌤️ <b>天气配置</b>\n开关: <code>${user.weather_enabled ? "开" : "关"}</code>\n地点: <code>${escape(user.weather_location || "未设置")}</code>\n预览: <code>${escape(preview.text || "暂无缓存")}</code>`, true);
              return;
            }
            await setWeather(invocation, context, "set", invocation.args.join(" ").trim());
          });
        },
      },
      config: {
        description: "查看完整配置",
        async handle(invocation, context) {
          await needUser(invocation, context, async (state, user) => {
            const fields = {
              "用户": user.user_id,
              "自动更新": user.is_enabled ? "开" : "关",
              "原始姓名": user.original_first_name,
              "原始姓氏": user.original_last_name || "(空)",
              "模式": user.mode,
              "时区": user.timezone,
              "时间显示": user.show_time !== false ? "开" : "关",
              "时间制式": `${user.hour_format === "12" ? "12" : "24"} 小时制`,
              "时钟表情": user.show_clock_emoji ? "开" : "关",
              "时区显示": user.show_timezone ? "开" : "关",
              "时区格式": user.timezone_format || "GMT",
              "文字样式": user.text_style || "normal",
              "组件顺序": user.display_order || "name,time",
              "文案数": state.random_texts.length,
              "下条文案序号": state.random_texts.length ? user.text_index % state.random_texts.length + 1 : "(空)",
              "天气显示": user.weather_enabled ? "开" : "关",
              "天气地点": user.weather_location || "未设置",
              "天气预览": user.weather_compact || "暂无缓存",
              "天气更新时间": user.weather_cache_ts ? new Date(user.weather_cache_ts).toISOString() : "尚未获取",
              "昵称更新时间": user.last_update || "尚未更新",
            };
            await edit(context, invocation,
              `<b>🔧 您的配置状态</b>\n${Object.entries(fields).map(([label, value]) => `${label}: <code>${escape(String(value ?? ""))}</code>`).join("\n")}`, true);
          });
        },
      },
      update: {
        aliases: ["now"],
        description: "立即更新昵称",
        async handle(invocation, context) {
          await needUser(invocation, context, async (_state, _user, userId) => {
            const updated = await updateUser(context, userId, true);
            await edit(context, invocation, updated ? "✅ 昵称已手动更新" : "❌ 更新失败");
          });
        },
      },
      reset: {
        description: "恢复原始昵称并停用",
        async handle(invocation, context) {
          await needUser(invocation, context, async (_state, user, userId) => {
            await context.telegram.withClient(async (client, signal) => {
              signal.throwIfAborted();
              await client.invoke(new Api.account.UpdateProfile({
                firstName: user.original_first_name || "",
                lastName: user.original_last_name || undefined,
              }));
            });
            await mutate(context, userId, target => { target.is_enabled = false; });
            await edit(context, invocation, "✅ <b>已恢复原始昵称并禁用自动更新</b>", true);
          });
        },
      },
    },
    help: [{heading: "命令说明：", body: "使用 <code>{prefix}acn</code> 查看完整帮助；所有设置保存在插件命名空间内。"}],
    async handle(invocation, context) {
      const subcommand = invocation.args[0]?.toLowerCase();
      if (!subcommand || subcommand === "help" || subcommand === "h") {
        await edit(context, invocation, renderPluginHelp(invocation.prefix), true);
        return;
      }
      await needUser(invocation, context, async () => {
        await edit(context, invocation,
          `❌ <b>未知命令</b>\n\n未知的子命令: <code>${escape(subcommand)}</code>\n\n输入 <code>${usage(invocation)}</code> 查看帮助。`, true);
      });
    },
  };

  const command = protectCommand(rawCommand);
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "autochangename",
    description: "按时区自动更新账号昵称",
    renderHelp: renderPluginHelp,
    commands: {acn: command, autochangename: {...command}},
    jobs: {
      update_names: {
        cron: "0 * * * * *",
        timeZone: "Asia/Shanghai",
        description: "每分钟更新已启用昵称",
        async handle(context, signal) {
          if (jobRunning) return;
          jobRunning = true;
          try {
            const state = await store(context).read();
            for (const userId of Object.keys(state.users).filter(id => state.users[id].is_enabled)) {
              signal.throwIfAborted();
              await updateUser(context, userId);
            }
          } finally {
            jobRunning = false;
          }
        },
      },
    },
    async setup(context) {
      await store(context).update(normalizeState);
    },
  });
}
