import {STRUCTURED_PLUGIN_API_VERSION, ui, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type PluginContext} from "telebox/sdk";
import {
  InputError, modes, providerTypes, readConfig, reasoningValues, record, requireInput, settings,
  tierValues, updateConfig, type Config,
} from "./v2/config";
import {
  assertAllowedModel, chatText, listProviderModels, ProviderError, translateText,
  type ChatImage, type ProviderMode, type ProviderType, type ReasoningEffort,
} from "./v2/provider";
import {escape, publish, searchText, sendText} from "./v2/text";
import {generateImages, generateVideos, materializeMedia, messageMedia, sendMedia, type MediaInput} from "./v2/media";

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
    const models = Object.entries(provider.models ?? {}).map(([mode, model]) => `${mode}=${model}`).join(" · ");
    return ui.concat(ui.text("• "), ui.code(tag), ui.text(` · ${provider.type ?? "auto"}${models ? ` · ${models}` : ""} · stream=${provider.stream ? "on" : "off"} · responses=${provider.responses ? "on" : "off"}`));
  });
  if (!providers.length) providers.push(ui.text("• 尚未配置 API"));
  return ui.concat(
    ui.bold("AI 配置"), ui.text("\n"), joinLines(providers), ui.text("\n\n"),
    ui.field("聊天", `${cfg.currentChatTag || "-"} / ${cfg.currentChatModel || "-"}`), ui.text("\n"),
    ui.field("搜索", `${cfg.currentSearchTag || "-"} / ${cfg.currentSearchModel || "-"}`), ui.text("\n"),
    ui.field("图片", `${cfg.currentImageTag || "-"} / ${cfg.currentImageModel || "-"}`), ui.text("\n"),
    ui.field("视频", `${cfg.currentVideoTag || "-"} / ${cfg.currentVideoModel || "-"}`), ui.text("\n"),
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
    const provider = cfg.configs[tag]; requireInput(provider, "API 配置不存在");
    raw[modeKey(mode, "Tag")] = tag; raw[modeKey(mode, "Model")] = model;
    raw.configs = {...record(raw.configs), [tag]: {...provider, models: {...record(provider.models), [mode]: model}}};
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
interface ServiceTextInput {
  text: string; systemPrompt?: string; model?: string; tag?: string; reasoningEffort?: ReasoningEffort;
  temperature?: number; maxOutputTokens?: number; images?: ChatImage[]; fallbackToChatCompletions?: boolean;
}
function serviceImages(input: unknown): ChatImage[] | undefined {
  if (input === undefined) return undefined;
  requireInput(Array.isArray(input) && input.length > 0 && input.length <= 4, "图片输入无效");
  let total = 0;
  const result = input.map(item => {
    requireInput(item !== null && typeof item === "object" && !Array.isArray(item), "图片输入无效");
    const value = item as Record<string, unknown>;
    requireInput(value.data instanceof Uint8Array && typeof value.mimeType === "string" && /^image\/(?:jpeg|png|gif|webp)$/i.test(value.mimeType), "图片输入无效");
    total += value.data.byteLength;
    return {data: Buffer.from(value.data), mimeType: value.mimeType.toLowerCase()};
  });
  requireInput(total <= 20 * 1024 * 1024, "图片输入过大");
  return result;
}
function serviceText(input: unknown): ServiceTextInput {
  if (typeof input === "string") return {text: input};
  requireInput(input !== null && typeof input === "object" && !Array.isArray(input), "服务输入无效");
  const value = input as Record<string, unknown>;
  requireInput(typeof value.text === "string" && value.text.trim(), "服务文本不能为空");
  requireInput(value.systemPrompt === undefined || typeof value.systemPrompt === "string", "系统提示词无效");
  requireInput(value.model === undefined || (typeof value.model === "string" && value.model.trim().length > 0), "模型无效");
  requireInput(value.tag === undefined || (typeof value.tag === "string" && value.tag.trim().length > 0), "提供商无效");
  requireInput(value.reasoningEffort === undefined || reasoningValues.includes(value.reasoningEffort as ReasoningEffort), "思考强度无效");
  requireInput(value.temperature === undefined || typeof value.temperature === "number" && Number.isFinite(value.temperature) && value.temperature >= 0 && value.temperature <= 2, "温度无效");
  requireInput(value.maxOutputTokens === undefined || Number.isSafeInteger(value.maxOutputTokens) && Number(value.maxOutputTokens) >= 1 && Number(value.maxOutputTokens) <= 32768, "输出上限无效");
  requireInput(value.fallbackToChatCompletions === undefined || typeof value.fallbackToChatCompletions === "boolean", "兼容回退选项无效");
  const images = serviceImages(value.images);
  return {text: value.text,
    ...(typeof value.systemPrompt === "string" ? {systemPrompt: value.systemPrompt} : {}),
    ...(typeof value.model === "string" ? {model: value.model.trim()} : {}),
    ...(typeof value.tag === "string" ? {tag: value.tag.trim()} : {}),
    ...(typeof value.reasoningEffort === "string" ? {reasoningEffort: value.reasoningEffort as ReasoningEffort} : {}),
    ...(typeof value.temperature === "number" ? {temperature: value.temperature} : {}),
    ...(typeof value.maxOutputTokens === "number" ? {maxOutputTokens: value.maxOutputTokens} : {}),
    ...(typeof value.fallbackToChatCompletions === "boolean" ? {fallbackToChatCompletions: value.fallbackToChatCompletions} : {}),
    ...(images ? {images} : {})};
}

function selectedModel(cfg: Config, tag: string, mode: ProviderMode, configured: string): string {
  const provider = cfg.configs[tag];
  requireInput(provider, "未找到指定的 AI 提供商");
  const title = `${mode[0].toUpperCase()}${mode.slice(1)}`;
  const selectedTag = String(cfg[`current${title}Tag`] ?? "");
  const model = tag === selectedTag ? configured || provider.models?.[mode] : provider.models?.[mode];
  requireInput(model, `请先配置 ai ${mode} 模型`);
  assertAllowedModel(model);
  return model;
}

interface ProviderImport {
  tag: string; url: string; key: string; type?: ProviderType; stream: boolean; responses: boolean;
  models: Partial<Record<ProviderMode, string>>; select: ProviderMode[];
}
function importedProvider(input: unknown): ProviderImport {
  requireInput(input !== null && typeof input === "object" && !Array.isArray(input), "导入配置无效");
  const value = input as Record<string, unknown>;
  const tag = typeof value.tag === "string" ? value.tag.trim() : "";
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const key = typeof value.key === "string" ? value.key.trim() : "";
  requireInput(/^[A-Za-z0-9._-]{1,64}$/.test(tag) && !["__proto__", "constructor", "prototype"].includes(tag), "导入标签无效");
  requireInput(url.length <= 2048 && key.length > 0 && key.length <= 8192, "导入配置无效");
  const parsed = new URL(url);
  requireInput(["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password, "导入地址无效");
  const type = typeof value.type === "string" ? value.type : undefined;
  if (type) requireInput(providerTypes.includes(type as typeof providerTypes[number]), "导入类型无效");
  const source = record(value.models); const models: Partial<Record<ProviderMode, string>> = {};
  for (const mode of ["chat", "search", "image", "video"] as const) if (typeof source[mode] === "string" && source[mode].trim()) {
    const model = source[mode].trim(); assertAllowedModel(model); models[mode] = model;
  }
  const select = Array.isArray(value.select) ? value.select.filter((mode): mode is ProviderMode =>
    typeof mode === "string" && ["chat", "search", "image", "video"].includes(mode)) : [];
  return {tag, url, key, ...(type ? {type: type as ProviderType} : {}), stream: value.stream === true,
    responses: value.responses === true, models, select};
}

function sameImportedProvider(current: Config["configs"][string], value: ProviderImport): boolean {
  return current.url === value.url && current.key === value.key && (current.type ?? "") === (value.type ?? "") &&
    current.stream === value.stream && current.responses === value.responses;
}

function availableImportTag(configs: Config["configs"], value: ProviderImport): {tag: string; existing?: Config["configs"][string]} {
  const requested = configs[value.tag];
  if (!requested || sameImportedProvider(requested, value)) return {tag: value.tag, ...(requested ? {existing: requested} : {})};
  for (let index = 2; index <= 999; index++) {
    const suffix = `-${index}`;
    const tag = `${value.tag.slice(0, 64 - suffix.length)}${suffix}`;
    const existing = configs[tag];
    if (!existing || sameImportedProvider(existing, value)) return {tag, ...(existing ? {existing} : {})};
  }
  throw new InputError("AI 导入标签已用尽");
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
    requireInput(/^[A-Za-z0-9._-]{1,64}$/.test(tag) && !["__proto__", "constructor", "prototype"].includes(tag), "配置标签无效");
    requireInput(url.length <= 2048 && key.length <= 8192, "API 配置过长");
    const target = new URL(url);
    requireInput(["https:", "http:"].includes(target.protocol) && !target.username && !target.password, "API 地址无效");
    providerType(type);
    await updateConfig(ctx, (raw, cfg) => {
      const configs = raw.configs && typeof raw.configs === "object" && !Array.isArray(raw.configs) ? raw.configs as Record<string, unknown> : {};
      configs[tag] = {tag, url, key, ...(type ? {type} : {}), stream: false,
        ...(cfg.configs[tag]?.models ? {models: {...cfg.configs[tag].models}} : {})};
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
        const provider = cfg.configs[tag];
        requireInput(provider, "未找到指定的 AI 提供商");
        const model = value.model ?? selectedModel(cfg, tag, "chat", cfg.currentChatModel);
        const selected = {...cfg, currentChatTag: tag, currentChatModel: model,
          currentChatReasoningEffort: value.reasoningEffort ?? cfg.currentChatReasoningEffort};
        const options = {images: value.images, temperature: value.temperature, maxOutputTokens: value.maxOutputTokens};
        try {
          return await chatText(selected, ctx.http, value.text, signal, value.systemPrompt ?? cfg.prompt, {}, options);
        } catch (error) {
          if (!value.fallbackToChatCompletions || !provider.responses || !(error instanceof ProviderError) ||
              error.code !== "HTTP_STATUS" || (error.status !== 400 && error.status !== 404)) throw error;
          const fallback = {...provider, responses: false};
          return chatText({...selected, configs: {...selected.configs, [tag]: fallback}},
            ctx.http, value.text, signal, value.systemPrompt ?? cfg.prompt, {}, options);
        }
      }},
      search: {description: "使用当前搜索模型联网检索并返回文字与来源", async handle(input, ctx, signal) {
        const value = serviceText(input); requireInput(!value.images, "搜索服务不接受图片");
        const cfg = await readConfig(ctx, signal); const tag = value.tag ?? cfg.currentSearchTag;
        requireInput(Boolean(cfg.configs[tag]), "未找到指定的 AI 提供商");
        const model = value.model ?? selectedModel(cfg, tag, "search", cfg.currentSearchModel);
        return searchText({...cfg, currentSearchTag: tag, currentSearchModel: model,
          currentSearchReasoningEffort: value.reasoningEffort ?? cfg.currentSearchReasoningEffort,
          prompt: value.systemPrompt ?? cfg.prompt}, ctx, value.text, signal);
      }},
      image: {description: "使用当前图片模型生成或编辑图片", async handle(input, ctx, signal) {
        requireInput(input !== null && typeof input === "object" && !Array.isArray(input), "图片服务输入无效");
        const value = input as Record<string, unknown>;
        requireInput(typeof value.prompt === "string" && value.prompt.trim(), "图片提示词不能为空");
        requireInput(value.tag === undefined || typeof value.tag === "string" && value.tag.trim(), "提供商无效");
        requireInput(value.model === undefined || typeof value.model === "string" && value.model.trim(), "模型无效");
        requireInput(value.timeoutMs === undefined || Number.isSafeInteger(value.timeoutMs) && Number(value.timeoutMs) >= 1000 && Number(value.timeoutMs) <= 1_800_000, "超时无效");
        const media = value.input === undefined ? undefined : serviceImages([value.input])?.[0];
        const cfg = await readConfig(ctx, signal); const tag = typeof value.tag === "string" ? value.tag.trim() : cfg.currentImageTag;
        requireInput(Boolean(cfg.configs[tag]), "未找到指定的 AI 提供商");
        const model = typeof value.model === "string" ? value.model.trim() : selectedModel(cfg, tag, "image", cfg.currentImageModel);
        const selected = {...cfg, currentImageTag: tag, currentImageModel: model,
          timeout: typeof value.timeoutMs === "number" ? value.timeoutMs / 1000 : cfg.timeout};
        const mediaInput = media ? {data: Buffer.from(media.data), mimeType: media.mimeType} : undefined;
        return materializeMedia(ctx, await generateImages(ctx, selected, value.prompt, mediaInput, signal), signal);
      }},
      models: {description: "列出统一配置中指定提供商可用的模型", async handle(input, ctx, signal) {
        requireInput(input === undefined || input === null || typeof input === "string" ||
          typeof input === "object" && !Array.isArray(input), "模型列表输入无效");
        const cfg = await readConfig(ctx, signal);
        const tag = typeof input === "string" ? input.trim() : input && typeof input === "object"
          ? String((input as Record<string,unknown>).tag ?? "").trim() : cfg.currentChatTag;
        requireInput(tag, "请提供 AI 配置标签");
        return listProviderModels(cfg, ctx.http, tag, signal);
      }},
      translate: {description: "使用当前聊天模型翻译文字", async handle(input, ctx, signal) {
        requireInput(input !== null && typeof input === "object" && !Array.isArray(input), "翻译输入无效");
        const value = input as Record<string, unknown>;
        requireInput(typeof value.text === "string" && value.text.trim(), "翻译文本不能为空");
        requireInput(value.target === "zh-CN" || value.target === "en", "翻译语言无效");
        return translateText(await readConfig(ctx, signal), ctx.http, value.text, value.target, signal);
      }},
      import_provider: {description: "把已安装插件的既有 AI 配置一次性迁入统一配置", async handle(input, ctx, signal) {
        const value = importedProvider(input); let imported = false; let actualTag = value.tag;
        await updateConfig(ctx, (raw, cfg) => {
          const target = availableImportTag(cfg.configs, value); actualTag = target.tag;
          const models = {...(target.existing?.models ?? {})};
          for (const [mode, model] of Object.entries(value.models)) if (model && !models[mode as ProviderMode]) models[mode as ProviderMode] = model;
          if (!target.existing) {
            raw.configs = {...record(raw.configs), [actualTag]: {tag: actualTag, url: value.url, key: value.key,
              ...(value.type ? {type: value.type} : {}), stream: value.stream, responses: value.responses, models: value.models}};
            imported = true;
          } else if (Object.keys(models).length !== Object.keys(target.existing.models ?? {}).length)
            raw.configs = {...record(raw.configs), [actualTag]: {...target.existing, models}};
          for (const mode of value.select) {
            const model = models[mode]; if (!model) continue;
            const title = `${mode[0].toUpperCase()}${mode.slice(1)}`;
            const tagKey = `current${title}Tag`; const modelKey = `current${title}Model`;
            if (!raw[tagKey] || !raw[modelKey]) { raw[tagKey] = actualTag; raw[modelKey] = model; }
          }
        }, signal);
        return {tag: actualTag, imported};
      }},
      selection: {description: "只读返回统一提供商及各模式的当前选择", async handle(_input, ctx, signal) {
        const cfg = await readConfig(ctx, signal);
        return {
          chat: {tag: cfg.currentChatTag, model: cfg.currentChatModel, reasoningEffort: cfg.currentChatReasoningEffort, serviceTier: cfg.currentChatServiceTier},
          search: {tag: cfg.currentSearchTag, model: cfg.currentSearchModel, reasoningEffort: cfg.currentSearchReasoningEffort, serviceTier: cfg.currentSearchServiceTier},
          image: {tag: cfg.currentImageTag, model: cfg.currentImageModel},
          video: {tag: cfg.currentVideoTag, model: cfg.currentVideoModel},
          providers: Object.keys(cfg.configs).sort().map(tag => ({tag, type: cfg.configs[tag].type ?? "auto", models: {...cfg.configs[tag].models}})),
        };
      }},
    },
  });
}
