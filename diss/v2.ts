import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type MessageEnvelope, type PluginContext, type SubcommandDefinition} from "telebox/sdk";
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

  const aiShow = async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
    const current = await configStore(ctx).read();
    const ai = await describeAi(ctx);
    const follow = ai ? `跟随 ai 插件（当前 ${escape(ai)}）` : "跟随 ai 插件";
    const value = (override: string) => override ? `<code>${escape(override)}</code>` : follow;
    const dynamic = [
      "<b>Diss AI 设置</b>",
      "自动回怼默认复用 ai 插件的聊天提供商，可在这里单独覆盖模型 / 提供商 / 思考强度。",
      "",
      "<b>当前</b>",
      `• 模型：${value(current.model)}`,
      `• 提供商：${value(current.tag)}`,
      `• 思考强度：${value(current.reasoningEffort)}`,
      "",
      "修改会在下次自动回怼时生效；只设模型不设 provider 时沿用 ai 当前聊天提供商。",
      "自动回怼可能产生调用费用；AI 不可用时使用本地模板。",
      "",
    ].join("\n");
    await ctx.telegram.edit(invocation.message, dynamic + renderCommandHelp("dissai", dissaiCommand, {prefix: invocation.prefix, title: ""}), {parseMode: "html"});
  };
  const aiSet = (field: keyof DissConfig, label: string): SubcommandDefinition => ({
    description: field === "model" ? "指定 diss 使用的模型" : field === "tag" ? "指定 ai 配置里的提供商" : "思考强度，可选 auto | none | minimal | low | medium | high | xhigh",
    args: "[值|reset]", examples: [{args: field === "model" ? "model gpt-4o" : field === "tag" ? "provider openai" : "reasoning high"}, {args: field === "model" ? "model reset" : field === "tag" ? "provider reset" : "reasoning reset"}],
    arguments: [{name: "值", description: "reset 恢复跟随 ai 插件"}],
    handle: guarded(async (invocation, ctx) => {
      const [action, ...extra] = invocation.args;
      if (!action) { await aiShow(invocation, ctx); return; }
      if (extra.length) { await ctx.telegram.edit(invocation.message, "值不能包含空格。"); return; }
      if (action === "reset" || action === "clear") {
        await configStore(ctx).update(current => ({...current, [field]: ""}));
        await ctx.telegram.edit(invocation.message, `已恢复跟随 ai 插件的${label}。`);
        return;
      }
      if (action.length > 128 || /\s/.test(action)) { await ctx.telegram.edit(invocation.message, "值无效（最长 128 字符且不能包含空格）。"); return; }
      if (field === "reasoningEffort" && !REASONING_VALUES.has(action)) {
        await ctx.telegram.edit(invocation.message, `思考强度必须是：<code>${[...REASONING_VALUES].join(" | ")}</code>`, {parseMode: "html"});
        return;
      }
      await configStore(ctx).update(current => ({...current, [field]: action}));
      await ctx.telegram.edit(invocation.message, `已设置 Diss ${label}：<code>${escape(action)}</code>`, {parseMode: "html"});
    }),
  });

  const dissCommand: CommandDefinition = {
    description: "锁定目标，TA 一说话就自动回怼",
    helpArgs: ["help", "h"],
    args: "[语录|@对方]",
    arguments: [{name: "语录", description: "发送语录获取一条祖安语录"}, {name: "@对方", description: "艾特锁定，或回复对方消息后发送本命令"}],
    examples: [{args: ""}, {args: "@对方"}, {args: "语录"}],
    help: [
      {heading: "说明：", body: "锁定后对方一说话就会自动回怼；对方只发表情包、图片、语音等（无文字）也会回怼。昵称里的花体时区（如 <code>𝟚𝟙:𝟜𝟙 𝔾𝕄𝕋+𝟠</code>）会自动去掉，只留昵称。可能产生调用费用；AI 不可用时使用本地模板。"},
    ],
    handle: guarded(async (invocation, ctx) => {
      const first = invocation.args[0]?.toLowerCase();
      if (first && QUOTE_ARGS.has(first)) { await doQuote(invocation, ctx); return; }
      await doLock(invocation, ctx);
    }),
  };

  const undissCommand: CommandDefinition = {
    description: "解锁目标（也可回复对方消息后发送本命令）", args: "[@对方]",
    arguments: [{name: "@对方", description: "艾特解锁，或回复对方消息后发送本命令"}],
    examples: [{args: "@对方"}],
    handle: guarded(doUnlock),
  };
  const dislistCommand: CommandDefinition = {
    description: "查看本会话锁定列表", args: "",
    examples: [{args: ""}],
    handle: guarded(doList),
  };
  const dissclearCommand: CommandDefinition = {
    description: "清空本会话锁定", args: "",
    examples: [{args: ""}],
    handle: guarded(doClear),
  };
  const dissaiCommand: CommandDefinition = {
    description: "配置自动回怼使用的 AI 模型/提供商/思考强度",
    args: "[model|provider|reasoning [值|reset]]",
    arguments: [{name: "字段", description: "model / provider / reasoning"}, {name: "值", description: "reset 恢复跟随 ai 插件"}],
    examples: [{args: ""}, {args: "model gpt-4o"}, {args: "provider openai"}, {args: "reasoning high"}, {args: "model reset"}],
    subcommandsCaseSensitive: false,
    subcommands: {
      model: aiSet("model", "模型"),
      provider: {...aiSet("tag", "提供商"), aliases: ["tag"]},
      reasoning: aiSet("reasoningEffort", "思考强度"),
    },
    help: [
      {heading: "说明：", body: "自动回怼默认复用 ai 插件的聊天提供商，可单独覆盖模型 / 提供商 / 思考强度；只设模型不设 provider 时沿用 ai 当前聊天提供商。修改会在下次自动回怼时生效。可能产生调用费用；AI 不可用时使用本地模板。"},
    ],
    handle: guarded(async (invocation, ctx) => {
      const scope = invocation.args[0];
      if (!scope || ["help", "h", "?"].includes(scope.toLowerCase())) { await aiShow(invocation, ctx); return; }
      await ctx.telegram.edit(invocation.message, `用法：<code>${escape(invocation.prefix)}dissai model|provider|reasoning [值|reset]</code>`, {parseMode: "html"});
    }),
  };

  const commands = {diss: dissCommand, undiss: undissCommand, dislist: dislistCommand, dissclear: dissclearCommand, dissai: dissaiCommand};
  const renderGuide = (prefix: string): string => Object.entries(commands)
    .map(([name, command], index) => renderCommandHelp(name, command, {prefix, ...(index === 0 ? {title: "🔫 Diss · 嘴臭对线机"} : {title: ""})}))
    .join("\n\n");
  const dishelpCommand: CommandDefinition = {
    description: "查看嘴臭对线机帮助", args: "",
    examples: [{args: ""}],
    handle: guarded(async (invocation, ctx) => {
      await ctx.telegram.edit(invocation.message, renderGuide(invocation.prefix), {parseMode: "html"});
    }),
  };
  (commands as Record<string, CommandDefinition>).dishelp = dishelpCommand;

  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "diss",
    description: "锁定目标后自动回怼的嘴臭对线机",
    renderHelp: renderGuide,
    commands: commands as Record<string, CommandDefinition>,
    listeners: [{
      direction: "incoming",
      async handle(message, ctx) {
        if (message.saved) return;
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
