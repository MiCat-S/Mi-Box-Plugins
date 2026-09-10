import {STRUCTURED_PLUGIN_API_VERSION, ui, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type PluginContext} from "telebox/sdk";
import {
  InputError, modes, providerTypes, readConfig, reasoningValues, requireInput, settings,
  tierValues, updateConfig, type Config,
} from "./v2/config";
import {assertAllowedModel, chatText, ProviderError, translateText, type ReasoningEffort} from "./v2/provider";
import {escape, publish, searchText, sendText} from "./v2/text";
import {generateImages, generateVideos, messageMedia, sendMedia, type MediaInput} from "./v2/media";

const htmlOptions = {parseMode: "html", linkPreview: false} as const;
function feedback(state: "working" | "success" | "error", title: string, detail?: string, nextStep?: string): ui.Html {
  return ui.renderFeedback({state, title, ...(detail ? {detail} : {}), ...(nextStep ? {nextStep} : {})});
}
function joinLines(rows: readonly ui.Html[]): ui.Html {
  const parts: ui.Html[] = [];
  rows.forEach((row, index) => { if (index) parts.push(ui.text("\n")); parts.push(row); });
  return ui.concat(...parts);
}
const bool = (value: string): boolean => {
  requireInput(value === "on" || value === "off", "请输入 on 或 off");
  return value === "on";
};
const modeKey = (mode: string, suffix: "Tag" | "Model" | "ReasoningEffort" | "ServiceTier"): keyof Config =>
  `current${mode[0].toUpperCase()}${mode.slice(1)}${suffix}` as keyof Config;
function visibleConfig(cfg: Config): ui.Html {
  const providers: ui.Html[] = Object.keys(cfg.configs).sort().map(tag => {
    const provider = cfg.configs[tag];
    return ui.concat(ui.text("• "), ui.code(tag), ui.text(` · ${provider.type ?? "auto"} · stream=${provider.stream ? "on" : "off"} · responses=${provider.responses ? "on" : "off"}`));
  });
  if (!providers.length) providers.push(ui.text("• 尚未配置 API"));
  return ui.concat(
    ui.bold("AI 配置"), ui.text("\n"), joinLines(providers), ui.text("\n\n"),
    ui.field("聊天", `${cfg.currentChatTag || "-"} / ${cfg.currentChatModel || "-"}`), ui.text("\n"),
    ui.field("搜索", `${cfg.currentSearchTag || "-"} / ${cfg.currentSearchModel || "-"}`), ui.text("\n"),
    ui.field("超时", `${cfg.timeout}s · 折叠=${cfg.collapse ? "on" : "off"}`),
  );
}
async function sourceText(invocation: CommandInvocation, ctx: PluginContext): Promise<string> {
  const own = invocation.args.join(" ").trim();
  if (own) return own;
  return (await ctx.telegram.getReply(invocation.message))?.text.trim() ?? "";
}
async function setModel(invocation: CommandInvocation, ctx: PluginContext): Promise<void> {
  const [mode = "", tag = "", model = ""] = invocation.args;
  requireInput(["chat", "search", "image", "video"].includes(mode) && tag && model, "用法：ai model chat|search|image|video tag model");
  assertAllowedModel(model);
  await updateConfig(ctx, (raw, cfg) => {
    requireInput(cfg.configs[tag], "API 配置不存在");
    raw[modeKey(mode, "Tag")] = tag; raw[modeKey(mode, "Model")] = model;
  });
  await ctx.telegram.edit(invocation.message, feedback("success", `${mode} 模型已设置`), htmlOptions);
}
async function setEnum(invocation: CommandInvocation, ctx: PluginContext, kind: "reasoning" | "service"): Promise<void> {
  const [mode = "", value = ""] = invocation.args;
  requireInput(["chat", "search"].includes(mode), `用法：ai ${kind} chat|search value`);
  const values = kind === "reasoning" ? reasoningValues : tierValues;
  requireInput(values.includes(value as never), "无效选项");
  await updateConfig(ctx, raw => { raw[modeKey(mode, kind === "reasoning" ? "ReasoningEffort" : "ServiceTier")] = value; });
  await ctx.telegram.edit(invocation.message, feedback("success", `${kind} 已设置为 ${value}`), htmlOptions);
}
async function ask(invocation: CommandInvocation, ctx: PluginContext, search: boolean): Promise<void> {
  const question = await sourceText(invocation, ctx);
  requireInput(question, search ? "请输入搜索问题或回复一条文字消息" : "请输入问题或回复一条文字消息");
  requireInput(question.length <= 100_000, "输入内容过长");
  const cfg = await readConfig(ctx);
  await ctx.telegram.edit(invocation.message, feedback("working", search ? "AI 搜索中" : "AI 思考中"), htmlOptions);
  if (search) {
    const answer = await searchText(cfg, ctx, question, ctx.signal);
    await sendText(ctx, invocation.message, answer.text, ctx.signal, cfg.collapse);
    if (answer.sources.length) {
      const sources = `<b>来源</b>\n${answer.sources.slice(0, 10).map((item, index) => `${index + 1}. <a href="${escape(item.url)}">${escape(item.title || item.url)}</a>`).join("\n")}`;
      await ctx.telegram.reply(invocation.message, sources, {parseMode: "html", linkPreview: false});
    }
    return;
  }
  const answer = await chatText(cfg, ctx.http, question, ctx.signal);
  if (cfg.telegraph.enabled && answer.length > 3500) {
    const url = await publish(ctx, cfg, question, answer, ctx.signal);
    await ctx.telegram.edit(invocation.message, `📰 <a href="${escape(url)}">在 Telegraph 阅读回答</a>`, {parseMode: "html", linkPreview: true});
  } else await sendText(ctx, invocation.message, answer, ctx.signal, cfg.collapse);
}
async function media(invocation: CommandInvocation, ctx: PluginContext, kind: "image" | "video"): Promise<void> {
  const cfg = await readConfig(ctx);
  const action = invocation.args[0]?.toLowerCase() ?? "";
  const mode = kind === "video" && (action === "first" || action === "firstlast") ? action : "auto";
  const offset = mode === "auto" ? 0 : 1;
  const ownPrompt = invocation.args.slice(offset).join(" ").trim();
  const replied = await ctx.telegram.getReply(invocation.message);
  const replyInput = await messageMedia(ctx, replied);
  const ownInput = await messageMedia(ctx, invocation.message);
  const inputs = [replyInput, ownInput].filter((item): item is MediaInput => item !== undefined);
  const replyText = replied?.text.trim() ?? "";
  const prompt = ownPrompt && replyText && !replyInput ? `${replyText}\n\n${ownPrompt}` : ownPrompt || replyText;
  requireInput(prompt || kind === "video" && inputs.length, kind === "image" ? "至少需要一条文字提示" : "至少需要文字提示或参考图");
  if (kind === "image") {
    await ctx.telegram.edit(invocation.message, feedback("working", "正在生成图片"), htmlOptions);
    const result = await generateImages(ctx, cfg, prompt, inputs[0], ctx.signal);
    await sendMedia(ctx, invocation.message, result, prompt, cfg.imagePreview, cfg.currentImageTag, "image", replied?.id);
    return;
  }
  const selected = mode === "first" ? inputs.slice(0, 1) : mode === "firstlast" ? inputs.slice(0, 2) : inputs.slice(0, 4);
  await ctx.telegram.edit(invocation.message, feedback("working", "正在生成视频"), htmlOptions);
  const result = await generateVideos(ctx, cfg, prompt, selected, ctx.signal);
  await sendMedia(ctx, invocation.message, result, prompt, cfg.videoPreview, cfg.currentVideoTag, "video", replied?.id);
}
function safeMessage(error: unknown): string {
  if (error instanceof InputError) return error.message;
  if (error instanceof ProviderError) return error.message;
  return "AI 操作失败，请检查配置、API 可用性和网络后重试";
}
interface ServiceTextInput {text: string; systemPrompt?: string; model?: string; tag?: string; reasoningEffort?: ReasoningEffort}
function serviceText(input: unknown): ServiceTextInput {
  if (typeof input === "string") return {text: input};
  requireInput(input !== null && typeof input === "object" && !Array.isArray(input), "服务输入无效");
  const value = input as Record<string, unknown>;
  requireInput(typeof value.text === "string" && value.text.trim(), "服务文本不能为空");
  requireInput(value.systemPrompt === undefined || typeof value.systemPrompt === "string", "系统提示词无效");
  requireInput(value.model === undefined || (typeof value.model === "string" && value.model.trim().length > 0), "模型无效");
  requireInput(value.tag === undefined || (typeof value.tag === "string" && value.tag.trim().length > 0), "提供商无效");
  requireInput(value.reasoningEffort === undefined || reasoningValues.includes(value.reasoningEffort as ReasoningEffort), "思考强度无效");
  return {text: value.text,
    ...(typeof value.systemPrompt === "string" ? {systemPrompt: value.systemPrompt} : {}),
    ...(typeof value.model === "string" ? {model: value.model.trim()} : {}),
    ...(typeof value.tag === "string" ? {tag: value.tag.trim()} : {}),
    ...(typeof value.reasoningEffort === "string" ? {reasoningEffort: value.reasoningEffort as ReasoningEffort} : {})};
}

export default function createAi() {
  const guard = (run: (invocation: CommandInvocation, ctx: PluginContext) => Promise<void>) =>
    async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
      try { await run(invocation, ctx); }
      catch (error) {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message,
          feedback("error", "AI 操作失败", safeMessage(error), "检查配置、API 可用性和网络后重试"), htmlOptions);
      }
    };
  const providerType = (value: string | undefined): void => { if (value) requireInput(providerTypes.includes(value as typeof providerTypes[number]), "无效 API 类型"); };
  const configList = guard(async (invocation, ctx) => { await ctx.telegram.edit(invocation.message, visibleConfig(await readConfig(ctx)), htmlOptions); });
  const configAdd = guard(async (invocation, ctx) => {
    const [tag = "", url = "", key = "", type] = invocation.args;
    requireInput(tag && url && key, "用法：ai config add tag url key [type]");
    requireInput(invocation.message.saved, "API Key 只能在收藏夹中配置");
    new URL(url);
    providerType(type);
    await updateConfig(ctx, raw => {
      const configs = raw.configs && typeof raw.configs === "object" && !Array.isArray(raw.configs) ? raw.configs as Record<string, unknown> : {};
      configs[tag] = {tag, url, key, ...(type ? {type} : {}), stream: false, responses: false};
      raw.configs = configs;
    });
    await ctx.telegram.edit(invocation.message, feedback("success", "AI 配置已更新"), htmlOptions);
  });
  const configDel = guard(async (invocation, ctx) => {
    const [tag = ""] = invocation.args;
    requireInput(tag, "用法：ai config del tag");
    await updateConfig(ctx, raw => {
      const configs = {...(raw.configs as Record<string, unknown> ?? {})};
      delete configs[tag]; raw.configs = configs;
      for (const mode of modes) if (raw[`current${mode}Tag`] === tag) {
        raw[`current${mode}Tag`] = ""; raw[`current${mode}Model`] = "";
      }
    });
    await ctx.telegram.edit(invocation.message, feedback("success", "AI 配置已更新"), htmlOptions);
  });
  const configToggle = (action: "type" | "stream" | "responses") => guard(async (invocation, ctx) => {
    const [tag = "", value = ""] = invocation.args;
    requireInput(tag && value, `用法：ai config ${action} tag value`);
    await updateConfig(ctx, (raw, cfg) => {
      const current = cfg.configs[tag]; requireInput(current, "API 配置不存在");
      if (action === "type") providerType(value);
      const next = action === "type" ? value : bool(value);
      raw.configs = {...(raw.configs as Record<string, unknown>), [tag]: {...current, [action]: next}};
    });
    await ctx.telegram.edit(invocation.message, feedback("success", "AI 配置已更新"), htmlOptions);
  });
  const promptSet = guard(async (invocation, ctx) => {
    const prompt = invocation.args.join(" ").trim();
    requireInput(prompt, "提示词不能为空");
    await updateConfig(ctx, raw => { raw.prompt = prompt; });
    await ctx.telegram.edit(invocation.message, feedback("success", "AI 输出设置已更新"), htmlOptions);
  });
  const promptDel = guard(async (invocation, ctx) => {
    await updateConfig(ctx, raw => { raw.prompt = ""; });
    await ctx.telegram.edit(invocation.message, feedback("success", "AI 输出设置已更新"), htmlOptions);
  });
  const setCollapse = guard(async (invocation, ctx) => {
    await updateConfig(ctx, raw => { raw.collapse = bool(invocation.args[0] ?? ""); });
    await ctx.telegram.edit(invocation.message, feedback("success", "AI 输出设置已更新"), htmlOptions);
  });
  const setTimeoutValue = guard(async (invocation, ctx) => {
    const seconds = Number(invocation.args[0]); requireInput(Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 600, "超时范围为 1-600 秒");
    await updateConfig(ctx, raw => { raw.timeout = seconds; });
    await ctx.telegram.edit(invocation.message, feedback("success", "AI 输出设置已更新"), htmlOptions);
  });
  const telegraphToggle = (enabled: boolean) => guard(async (invocation, ctx) => {
    await updateConfig(ctx, raw => {
      const current = raw.telegraph && typeof raw.telegraph === "object" && !Array.isArray(raw.telegraph) ? raw.telegraph as Record<string, unknown> : {};
      raw.telegraph = {...current, enabled};
    });
    await ctx.telegram.edit(invocation.message, feedback("success", "AI 输出设置已更新"), htmlOptions);
  });
  const telegraphLimit = guard(async (invocation, ctx) => {
    const limit = Number(invocation.args[0]); requireInput(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "记录容量范围为 1-100");
    await updateConfig(ctx, raw => {
      const current = raw.telegraph && typeof raw.telegraph === "object" && !Array.isArray(raw.telegraph) ? raw.telegraph as Record<string, unknown> : {};
      raw.telegraph = {...current, limit};
    });
    await ctx.telegram.edit(invocation.message, feedback("success", "AI 输出设置已更新"), htmlOptions);
  });
  const telegraphDel = guard(async (invocation, ctx) => {
    requireInput(invocation.args[0] === "all", "用法：ai telegraph on|off|limit 数量|del all");
    await updateConfig(ctx, raw => {
      const current = raw.telegraph && typeof raw.telegraph === "object" && !Array.isArray(raw.telegraph) ? raw.telegraph as Record<string, unknown> : {};
      raw.telegraph = {...current, list: []};
    });
    await ctx.telegram.edit(invocation.message, feedback("success", "AI 输出设置已更新"), htmlOptions);
  });
  const mediaPreview = (kind: "image" | "video") => guard(async (invocation, ctx) => {
    const value = invocation.args[0]?.toLowerCase() ?? "";
    requireInput(value === "on" || value === "off", `用法：ai ${kind} preview on|off`);
    await updateConfig(ctx, raw => { raw[kind === "image" ? "imagePreview" : "videoPreview"] = value === "on"; });
    await ctx.telegram.edit(invocation.message, feedback("success", `${kind} preview 已设置为 ${value}`), htmlOptions);
  });
  const videoAudio = guard(async (invocation, ctx) => {
    const value = invocation.args[0]?.toLowerCase() ?? "";
    requireInput(value === "on" || value === "off", "用法：ai video audio on|off");
    await updateConfig(ctx, raw => { raw.videoAudio = value === "on"; });
    await ctx.telegram.edit(invocation.message, feedback("success", `video audio 已设置为 ${value}`), htmlOptions);
  });
  const videoDuration = guard(async (invocation, ctx) => {
    const seconds = Number(invocation.args[0]);
    requireInput(Number.isSafeInteger(seconds) && seconds >= 5 && seconds <= 20, "视频时长范围为 5-20 秒");
    await updateConfig(ctx, raw => { raw.videoDuration = seconds; });
    await ctx.telegram.edit(invocation.message, feedback("success", `视频时长已设置为 ${seconds} 秒`), htmlOptions);
  });
  const aiCommand: CommandDefinition = {
    description: "AI 对话、搜索与配置",
    helpArgs: ["help", "?"],
    args: "[问题]",
    arguments: [{name: "问题", description: "直接提问，或回复一条文字消息补充上下文"}],
    examples: [{args: "用三句话解释 DNS"}, {args: "search 最新新闻"}, {args: "image 赛博朋克城市"}],
    subcommandsCaseSensitive: false,
    subcommands: {
      help: {group: "📌 使用说明:", aliases: ["?"], description: "显示完整帮助", args: "", examples: [{args: "help"}], handle: async (invocation, ctx) => { await ctx.telegram.edit(invocation.message, renderAiHelp(invocation.prefix), htmlOptions); }},
      config: {
        group: "⚙️ API 配置:",
        description: "管理 API 配置", args: "add|del|list|type|stream|responses ...",
        defaultSubcommand: "list",
        subcommandsCaseSensitive: true,
        subcommands: {
          add: {description: "添加 API 配置", args: "tag url key [type]", arguments: [{name: "tag", required: true}, {name: "url", required: true}, {name: "key", required: true, description: "仅收藏夹中配置"}, {name: "type", description: providerTypes.join("/")}], examples: [{args: "add main https://api.openai.com secret openai-compatible"}], handle: configAdd},
          del: {description: "删除 API 配置", args: "tag", examples: [{args: "del main"}], handle: configDel},
          list: {description: "列出已配置 API", args: "", examples: [{args: "list"}], handle: configList},
          type: {description: "设置 API 类型；不设置时按 URL 特征自动识别", args: "tag type", arguments: [{name: "type", required: true, description: providerTypes.join("/")}], examples: [{args: "type main gemini"}], handle: configToggle("type")},
          stream: {description: "设置 API 流式传输", args: "tag on|off", examples: [{args: "stream main on"}], handle: configToggle("stream")},
          responses: {description: "设置 chat/search 的 Responses 模式", args: "tag on|off", examples: [{args: "responses main on"}], handle: configToggle("responses")},
        },
        handle: guard(async () => { throw new InputError("未知 config 子命令"); }),
        help: [{heading: "API 类型：", body: `可选值：${providerTypes.join(" / ")}。若不设置，按 URL 特征自动识别。`}],
      },
      model: {group: "🧠 模型设置:", description: "设置聊天/搜索/图片/视频模型", args: "chat|search|image|video tag model", examples: [{args: "model chat main gpt-4o"}], handle: guard(setModel)},
      reasoning: {group: "🧠 模型设置:", description: "设置思考强度", args: "chat|search auto|none|minimal|low|medium|high|xhigh", examples: [{args: "reasoning chat medium"}], handle: guard((invocation, ctx) => setEnum(invocation, ctx, "reasoning"))},
      service: {group: "🧠 模型设置:", description: "设置服务等级", args: "chat|search auto|default|priority|fast|flex", examples: [{args: "service chat auto"}], handle: guard((invocation, ctx) => setEnum(invocation, ctx, "service"))},
      image: {
        group: "💬 提问:",
        description: "文生/编辑图片", args: "提示词",
        subcommands: {
          preview: {description: "开/关图片预览", args: "on|off", examples: [{args: "preview on"}], handle: mediaPreview("image")},
        },
        handle: guard(async (invocation, ctx) => media(invocation, ctx, "image")),
      },
      video: {
        group: "💬 提问:",
        description: "文生/参考图生成视频", args: "[first|firstlast] 提示词",
        subcommands: {
          preview: {description: "开/关视频预览", args: "on|off", examples: [{args: "preview on"}], handle: mediaPreview("video")},
          audio: {description: "开/关视频音频", args: "on|off", examples: [{args: "audio on"}], handle: videoAudio},
          duration: {description: "视频输出时长（5-20 秒）", args: "秒数", examples: [{args: "duration 10"}], handle: videoDuration},
        },
        handle: guard(async (invocation, ctx) => media(invocation, ctx, "video")),
      },
      prompt: {
        group: "✍️ 提示词:",
        description: "设置或删除提示词", args: "set 内容|del", caseSensitive: true,
        subcommands: {
          set: {description: "设置提示词", args: "内容", examples: [{args: "set 用中文回答"}], handle: promptSet},
          del: {description: "删除提示词", args: "", examples: [{args: "del"}], handle: promptDel},
        },
        handle: guard(async () => { throw new InputError("用法：ai prompt set 内容 | ai prompt del"); }),
      },
      collapse: {group: "🧩 消息设置:", description: "开/关消息折叠", args: "on|off", caseSensitive: true, examples: [{args: "collapse on"}], handle: setCollapse},
      timeout: {group: "🧩 消息设置:", description: "设置超时时间（1-600 秒）", args: "秒数", caseSensitive: true, examples: [{args: "timeout 120"}], handle: setTimeoutValue},
      telegraph: {
        group: "📰 Telegraph:",
        description: "管理 Telegraph 长文", args: "on|off|limit 数量|del all", caseSensitive: true,
        subcommands: {
          on: {description: "开启 Telegraph", args: "", examples: [{args: "on"}], handle: telegraphToggle(true)},
          off: {description: "关闭 Telegraph", args: "", examples: [{args: "off"}], handle: telegraphToggle(false)},
          limit: {description: "设置记录容量（1-100）", args: "数量", examples: [{args: "limit 50"}], handle: telegraphLimit},
          del: {description: "删除全部记录（仅支持 del all）", args: "all", examples: [{args: "del all"}], handle: telegraphDel},
        },
        handle: guard(async () => { throw new InputError("用法：ai telegraph on|off|limit 数量|del all"); }),
      },
      search: {group: "💬 提问:", description: "联网搜索并回答", args: "问题", examples: [{args: "search 今天有什么新闻"}], handle: guard(async (invocation, ctx) => ask(invocation, ctx, true))},
    },
    help: [
      {heading: "使用说明：", body: "• <code>{prefix}ai 问题</code> 直接提问；回复一条文字消息后发送 <code>{prefix}ai</code> 会带上该文字\n• 不回复且没有问题时提示缺少输入\n• <code>{prefix}ai search 问题</code> 联网搜索；<code>{prefix}ai image/video 提示词</code> 生成媒体"},
      {heading: "密钥配置：", body: "涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。"},
    ],
    handle: guard(async (invocation, ctx) => ask(invocation, ctx, false)),
  };
  const renderAiHelp = (prefix: string): string => renderCommandHelp("ai", aiCommand, {prefix, title: "🤖 智能 AI 助手"});
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "ai", description: "AI 对话、搜索、媒体生成与配置", renderHelp: renderAiHelp, settings,
    commands: {ai: aiCommand},
    services: {
      chat: {description: "使用当前聊天模型生成文字，可指定 model/tag/reasoningEffort", async handle(input, ctx, signal) {
        const value = serviceText(input); const cfg = await readConfig(ctx, signal);
        const tag = value.tag ?? cfg.currentChatTag;
        requireInput(Object.hasOwn(cfg.configs, tag) && Boolean(cfg.configs[tag]), "未找到指定的 AI 提供商");
        return chatText({...cfg, currentChatTag: tag, currentChatModel: value.model ?? cfg.currentChatModel,
          currentChatReasoningEffort: value.reasoningEffort ?? cfg.currentChatReasoningEffort},
        ctx.http, value.text, signal, value.systemPrompt ?? cfg.prompt);
      }},
      translate: {description: "使用当前聊天模型翻译文字", async handle(input, ctx, signal) {
        requireInput(input !== null && typeof input === "object" && !Array.isArray(input), "翻译输入无效");
        const value = input as Record<string, unknown>;
        requireInput(typeof value.text === "string" && value.text.trim(), "翻译文本不能为空");
        requireInput(value.target === "zh-CN" || value.target === "en", "翻译语言无效");
        return translateText(await readConfig(ctx, signal), ctx.http, value.text, value.target, signal);
      }},
      selection: {description: "只读返回当前聊天与搜索的提供商/模型选择", async handle(_input, ctx, signal) {
        const cfg = await readConfig(ctx, signal);
        return {
          chat: {tag: cfg.currentChatTag, model: cfg.currentChatModel, reasoningEffort: cfg.currentChatReasoningEffort, serviceTier: cfg.currentChatServiceTier},
          search: {tag: cfg.currentSearchTag, model: cfg.currentSearchModel, reasoningEffort: cfg.currentSearchReasoningEffort, serviceTier: cfg.currentSearchServiceTier},
        };
      }},
    },
  });
}
