import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type CommandInvocation, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import type {Api} from "teleproto";
import {INSULTS, PERSONA, cleanInsult, pick, styleFor} from "./v2/insults";
import {fetchQuote} from "./v2/quote";

type TargetInfo = {name: string; lockedAt: number; hits: number};
type State = Record<string, Record<string, TargetInfo>>;
type DissConfig = {model: string; tag: string; reasoningEffort: string};
type AiSelection = {chat?: {tag?: string; model?: string; reasoningEffort?: string}};

const COOLDOWN_MS = 2_500;
const CONFIG_DEFAULTS: DissConfig = {model: "", tag: "", reasoningEffort: ""};
const REASONING_VALUES = new Set(["auto", "none", "minimal", "low", "medium", "high", "xhigh"]);
const QUOTE_ARGS = new Set(["语录", "quote", "yulu", "saying"]);
const TIME_PART = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
const TZ_PART = String.raw`(?:GMT|UTC|UT)\s*(?:[+-]\s*\d{1,2}(?::\d{2})?)?`;
/** Trailing clock/GMT timezone, including fancy Unicode forms once NFKD-normalized. */
const TZ_SUFFIX = new RegExp(String.raw`[\s|·•\-–—]*[（(\[【]?\s*(?:${TIME_PART}\s*${TZ_PART}|${TZ_PART}|${TIME_PART})\s*[）)\]】]?\s*$`, "u");
const escape = (value: string): string =>
  String(value).replace(/[&<>"]/g, character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"})[character]!);

function nameOf(message: MessageEnvelope | undefined): string {
  if (!message) return "";
  const sender = (message.raw as {sender?: {firstName?: string; lastName?: string; title?: string; username?: string}} | undefined)?.sender;
  if (!sender) return "";
  const name = `${sender.firstName ?? ""} ${sender.lastName ?? ""}`.trim();
  if (name) return cleanName(name);
  if (sender.title) return cleanName(String(sender.title));
  if (sender.username) return `@${sender.username}`;
  return "";
}

/**
 * Keep the nickname but drop a trailing clock/GMT timezone such as `江砚 𝟚𝟙:𝟜𝟙 𝔾𝕄𝕋+𝟠`.
 * NFKD only drives detection; the returned prefix is sliced from the original text,
 * so the nickname's own characters (including fancy ones) are preserved.
 */
function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  const points = Array.from(trimmed);
  let normalized = "";
  const map: number[] = [];
  for (let index = 0; index < points.length; index++) {
    const part = points[index]!.normalize("NFKD");
    for (const character of part) {
      normalized += character;
      for (let unit = 0; unit < character.length; unit++) map.push(index);
    }
  }
  const match = TZ_SUFFIX.exec(normalized);
  if (!match || match.index === undefined) return trimmed;
  const cut = map[match.index] ?? points.length;
  const cleaned = points.slice(0, cut).join("").trim();
  return cleaned || trimmed;
}

type MediaHints = {
  sticker?: {alt?: string}; videoNote?: unknown; voice?: unknown; audio?: unknown;
  gif?: unknown; video?: unknown; photo?: unknown; contact?: unknown;
  geo?: unknown; poll?: unknown; document?: unknown;
};

/** Describe a media-only message so a locked target still gets a relevant reply. */
function contentHint(message: MessageEnvelope): string {
  const raw = message.raw as MediaHints | undefined;
  if (!raw) return "";
  if (raw.sticker) return `发了一个表情包${raw.sticker.alt ? `（${raw.sticker.alt}）` : ""}`;
  if (raw.videoNote) return "发了一个圆形视频";
  if (raw.voice) return "发了一段语音";
  if (raw.audio) return "发了一段音频";
  if (raw.gif) return "发了一个 GIF";
  if (raw.video) return "发了一段视频";
  if (raw.photo) return "发了一张图片";
  if (raw.contact) return "发了一张名片";
  if (raw.geo) return "发了一个位置";
  if (raw.poll) return "发了一个投票";
  if (raw.document) return "发了一个文件";
  return "";
}

/** Read-only view of the ai plugin's current chat selection, used only for help text. */
async function describeAi(ctx: PluginContext): Promise<string> {
  if (!ctx.services.available("ai", "selection")) return "";
  try {
    const selection = await ctx.services.call<AiSelection>("ai", "selection", null, ctx.signal);
    const chat = selection?.chat;
    if (!chat?.tag || !chat?.model) return "";
    return `${chat.tag} / ${chat.model} · 思考 ${chat.reasoningEffort ?? "auto"}`;
  } catch { return ""; }
}

export default function createDiss() {
  let state: State = {};
  let loading: Promise<void> | undefined;
  let self: {id: string; username: string} | undefined;
  const cooldown = new Map<string, number>();
  const inFlight = new Set<string>();

  const store = (ctx: PluginContext) => ctx.storage.json<State>("state.json", {});
  const configStore = (ctx: PluginContext) => ctx.storage.json<DissConfig>("config.json", CONFIG_DEFAULTS);
  const ensure = (ctx: PluginContext): Promise<void> => {
    loading ??= store(ctx).read().then(value => {state = value;}, error => {loading = undefined; throw error;});
    return loading;
  };

  const selfInfo = async (ctx: PluginContext): Promise<{id: string; username: string}> => {
    if (self) return self;
    const me = await ctx.telegram.withClient(client => client.getMe());
    self = {id: String(me.id), username: String(me.username ?? "")};
    return self;
  };

  const mutate = async (ctx: PluginContext, change: (current: State) => State): Promise<void> => {
    await ensure(ctx);
    state = await store(ctx).update(current => change(current));
  };

  const resolveUsername = async (ctx: PluginContext, username: string): Promise<{id: string; name: string} | undefined> => {
    if (!/^[A-Za-z0-9_]{3,64}$/.test(username)) return undefined;
    try {
      const entity = await ctx.telegram.withClient(client => client.getEntity(`@${username}`));
      const id = (entity as {id?: unknown} | undefined)?.id;
      if (id == null) return undefined;
      return {id: String(id), name: `@${username}`};
    } catch {
      return undefined;
    }
  };

  const resolveTarget = async (invocation: CommandInvocation, ctx: PluginContext): Promise<{id: string; name: string} | undefined> => {
    const raw = invocation.message.raw as Api.Message | undefined;
    const text = raw?.message ?? invocation.message.text;
    for (const entity of raw?.entities ?? []) {
      if (entity.className === "MessageEntityMentionName" && entity.userId != null) {
        const name = text.slice(entity.offset, entity.offset + entity.length).replace(/^@/, "");
        return {id: String(entity.userId), name: cleanName(name) || `用户${entity.userId}`};
      }
      if (entity.className === "MessageEntityMention") {
        const username = text.slice(entity.offset, entity.offset + entity.length).replace(/^@/, "");
        const resolved = await resolveUsername(ctx, username);
        if (resolved) return resolved;
      }
    }
    const mentioned = text.match(/@([A-Za-z0-9_]{3,64})/);
    if (mentioned) {
      const resolved = await resolveUsername(ctx, mentioned[1]);
      if (resolved) return resolved;
    }
    const numeric = text.match(/(?:^|\s)(\d{5,16})(?:\s|$)/);
    if (numeric) return {id: numeric[1], name: `用户${numeric[1]}`};
    const reply = await ctx.telegram.getReply(invocation.message);
    if (reply?.senderId) return {id: reply.senderId, name: nameOf(reply) || `用户${reply.senderId}`};
    return undefined;
  };

  const doLock = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const target = await resolveTarget(invocation, ctx);
    if (!target) {
      await ctx.telegram.edit(invocation.message,
        `📢 用法：回复对方的消息发 <code>${escape(invocation.prefix)}diss</code>，或 <code>${escape(invocation.prefix)}diss @对方</code>。`,
        {parseMode: "html"});
      return;
    }
    const me = await selfInfo(ctx);
    if (target.id === me.id || target.id === invocation.message.senderId) {
      await ctx.telegram.edit(invocation.message, "❌ 锁定目标无效（不能锁自己）。", {parseMode: "html"});
      return;
    }
    const chat = invocation.message.chatId;
    await mutate(ctx, current => {
      const chats = {...current};
      const map = {...(chats[chat] ?? {})};
      const display = cleanName(target.name) || `用户${target.id}`;
      map[target.id] = {name: display, lockedAt: Date.now(), hits: map[target.id]?.hits ?? 0};
      chats[chat] = map;
      return chats;
    });
    await ctx.telegram.edit(invocation.message,
      `🔫 已锁定 <b>${escape(cleanName(target.name) || target.name)}</b>（<code>${escape(target.id)}</code>），TA 一张嘴就喷死 TA。`,
      {parseMode: "html"});
  };

  const doUnlock = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const target = await resolveTarget(invocation, ctx);
    if (!target) {
      await ctx.telegram.edit(invocation.message,
        `📢 用法：回复对方的消息发 <code>${escape(invocation.prefix)}undiss</code>，或 <code>${escape(invocation.prefix)}undiss @对方</code>。`,
        {parseMode: "html"});
      return;
    }
    const chat = invocation.message.chatId;
    await mutate(ctx, current => {
      const chats = {...current};
      const map = {...(chats[chat] ?? {})};
      delete map[target.id];
      if (Object.keys(map).length) chats[chat] = map; else delete chats[chat];
      return chats;
    });
    await ctx.telegram.edit(invocation.message,
      `🔓 已解锁 <b>${escape(target.name)}</b>，放过 TA 了。`, {parseMode: "html"});
  };

  const doList = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    await ensure(ctx);
    const entries = Object.entries(state[invocation.message.chatId] ?? {});
    if (!entries.length) {
      await ctx.telegram.edit(invocation.message, "📭 当前会话暂无锁定目标。");
      return;
    }
    const lines = entries.map(([id, info]) => `• <b>${escape(info.name)}</b> <code>${escape(id)}</code> · 已喷 ${info.hits} 次`);
    await ctx.telegram.edit(invocation.message,
      `🔫 本会话已锁定 ${entries.length} 人：\n${lines.join("\n")}`, {parseMode: "html"});
  };

  const doClear = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const chat = invocation.message.chatId;
    await mutate(ctx, current => {
      const chats = {...current};
      delete chats[chat];
      return chats;
    });
    await ctx.telegram.edit(invocation.message, "🧹 本会话锁定已全部清除。");
  };

  const doHelp = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    await ctx.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), {parseMode: "html"});
  };

  const doQuote = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    try {
      await ctx.telegram.edit(invocation.message, "🔄 正在获取语录…");
      const text = await fetchQuote(ctx, ctx.signal);
      await ctx.telegram.edit(invocation.message, escape(text), {parseMode: "html", linkPreview: false});
    } catch {
      if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "语录获取失败，请稍后重试");
    }
  };

  const buildInsult = async (ctx: PluginContext, signal: AbortSignal, text: string, name: string): Promise<string> => {
    const {maxSentences, style} = styleFor();
    if (ctx.services.available("ai", "chat")) {
      try {
        const config = await configStore(ctx).read();
        const input: Record<string, unknown> = {
          text: `对方昵称：${name}\n对方刚说的话：${text || "(没说话，只发了媒体/表情)"}\n\n怼回去。${style}`,
          systemPrompt: PERSONA,
        };
        if (config.model) input.model = config.model;
        if (config.tag) input.tag = config.tag;
        if (config.reasoningEffort) input.reasoningEffort = config.reasoningEffort;
        const result = await ctx.services.call<unknown>("ai", "chat", input, signal);
        const cleaned = cleanInsult(String(result ?? ""), name, maxSentences);
        if (cleaned) return cleaned;
      } catch { /* fall through to the local list */ }
    }
    return pick(INSULTS).replace(/\{name\}/g, name || "憨批");
  };

  const autoReply = (message: MessageEnvelope, info: TargetInfo, ctx: PluginContext, content: string): void => {
    const senderId = message.senderId;
    if (!senderId) return;
    const key = `${message.chatId}:${senderId}`;
    const now = Date.now();
    if (inFlight.has(key) || (cooldown.get(key) ?? 0) > now) return;
    cooldown.set(key, now + COOLDOWN_MS);
    if (cooldown.size > 512) for (const [entry, until] of cooldown) if (until <= now) cooldown.delete(entry);
    inFlight.add(key);
    void ctx.tasks.run("diss:reply", async signal => {
      try {
        const name = cleanName(info.name) || `用户${senderId}`;
        const insult = await buildInsult(ctx, signal, content, name);
        signal.throwIfAborted();
        if (!insult) return;
        await ctx.telegram.reply(message, escape(insult), {parseMode: "html"});
        await mutate(ctx, current => {
          const chats = {...current};
          const map = {...(chats[message.chatId] ?? {})};
          const stored = map[senderId];
          if (stored) map[senderId] = {...stored, hits: (stored.hits ?? 0) + 1};
          chats[message.chatId] = map;
          return chats;
        });
      } catch { /* cancelled or delivery failed; keep listening */ }
      finally { inFlight.delete(key); }
    });
  };

  const doAi = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const store = configStore(ctx);
    const [scope, action, ...extra] = invocation.args;
    const prefix = escape(invocation.prefix);
    const show = async () => {
      const current = await store.read();
      const ai = await describeAi(ctx);
      const follow = ai ? `跟随 ai 插件（当前 ${escape(ai)}）` : "跟随 ai 插件";
      const value = (override: string) => override ? `<code>${escape(override)}</code>` : follow;
      await ctx.telegram.edit(invocation.message, [
        "<b>Diss AI 设置</b>",
        "自动回怼默认复用 ai 插件的聊天提供商，可在这里单独覆盖模型 / 提供商 / 思考强度。",
        "",
        "<b>当前</b>",
        `• 模型：${value(current.model)}`,
        `• 提供商：${value(current.tag)}`,
        `• 思考强度：${value(current.reasoningEffort)}`,
        "",
        "<b>修改</b>",
        `<code>${prefix}dissai model 模型名</code>`,
        `<code>${prefix}dissai provider tag</code>`,
        `<code>${prefix}dissai reasoning 级别</code>`,
        `<code>${prefix}dissai model reset</code> 恢复跟随 ai 插件（provider / reasoning 同理）`,
        "",
        `思考强度可选：<code>${[...REASONING_VALUES].join(" | ")}</code>`,
        `查看 ai 的提供商：<code>${prefix}ai config list</code>`,
        "改完需 <code>.tpm update ai</code> 与 <code>.tpm update diss</code> 后才生效。",
        "自动回怼可能产生调用费用；AI 不可用时使用本地模板。",
      ].join("\n"), {parseMode: "html"});
    };
    if (!scope || ["help", "h", "?"].includes(scope.toLowerCase())) { await show(); return; }
    const key = scope.toLowerCase();
    const field: keyof DissConfig | undefined = key === "model" ? "model"
      : key === "provider" || key === "tag" ? "tag"
        : key === "reasoning" ? "reasoningEffort" : undefined;
    if (!field) {
      await ctx.telegram.edit(invocation.message, `用法：<code>${prefix}dissai model|provider|reasoning [值|reset]</code>`, {parseMode: "html"});
      return;
    }
    if (!action) { await show(); return; }
    const label = field === "model" ? "模型" : field === "tag" ? "提供商" : "思考强度";
    if (extra.length) {
      await ctx.telegram.edit(invocation.message, "值不能包含空格。");
      return;
    }
    if (action === "reset" || action === "clear") {
      await store.update(current => ({...current, [field]: ""}));
      await ctx.telegram.edit(invocation.message, `已恢复跟随 ai 插件的${label}。`);
      return;
    }
    if (action.length > 128 || /\s/.test(action)) {
      await ctx.telegram.edit(invocation.message, "值无效（最长 128 字符且不能包含空格）。");
      return;
    }
    if (field === "reasoningEffort" && !REASONING_VALUES.has(action)) {
      await ctx.telegram.edit(invocation.message, `思考强度必须是：<code>${[...REASONING_VALUES].join(" | ")}</code>`, {parseMode: "html"});
      return;
    }
    await store.update(current => ({...current, [field]: action}));
    await ctx.telegram.edit(invocation.message, `已设置 Diss ${label}：<code>${escape(action)}</code>`, {parseMode: "html"});
  };

  /** Show a fixed message instead of leaking transport or provider errors to the chat. */
  const guarded = (operation: (invocation: CommandInvocation, ctx: PluginContext) => Promise<void>) =>
    async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
      try { await operation(invocation, ctx); }
      catch (error) {
        ctx.log.error("diss.command_failed", {kind: error instanceof Error ? error.name : "unknown"});
        if (!ctx.signal.aborted) {
          try { await ctx.telegram.edit(invocation.message, "❌ 操作失败，请稍后重试"); } catch { /* delivery failed too */ }
        }
      }
    };

  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "diss",
    description: "锁定目标后自动回怼的嘴臭对线机",
    commands: {
      diss: {description: "锁定目标，TA 一说话就自动回怼", helpArgs: ["help", "h"],
        handle: guarded(async (invocation, ctx) => {
          const first = invocation.args[0]?.toLowerCase();
          if (first && QUOTE_ARGS.has(first)) { await doQuote(invocation, ctx); return; }
          await doLock(invocation, ctx);
        })},
      undiss: {description: "解锁目标", handle: guarded(doUnlock)},
      dislist: {description: "查看本会话锁定列表", handle: guarded(doList)},
      dissclear: {description: "清空本会话锁定", handle: guarded(doClear)},
      dishelp: {description: "查看嘴臭对线机帮助", handle: guarded(doHelp)},
      dissai: {description: "配置自动回怼使用的 AI 模型/提供商/思考强度", handle: guarded(doAi)},
    },
    listeners: [{
      async handle(message, ctx) {
        if (message.outgoing || message.saved) return;
        if (!message.senderId) return;
        if ((message.raw as {action?: unknown} | undefined)?.action) return;
        const content = message.text.trim() || contentHint(message);
        if (!content) return;
        await ensure(ctx);
        const info = state[message.chatId]?.[message.senderId];
        if (!info) return;
        autoReply(message, info, ctx, content);
      },
    }],
  });
}
