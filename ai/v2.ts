import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, ui, type CommandInvocation, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {
  InputError, modes, providerTypes, readConfig, reasoningValues, requireInput, settings,
  tierValues, updateConfig, type Config,
} from "./v2/config";
import {assertAllowedModel, chatText, ProviderError, translateText} from "./v2/provider";
import {escape, publish, searchText, sendText} from "./v2/text";
import {generateImages, generateVideos, messageMedia, sendMedia, type MediaInput} from "./v2/media";

function help(prefix: string): ui.Html {
  const line = (args: string | readonly string[], detail = ""): ui.Html =>
    ui.concat(ui.text("• "), ui.command(prefix, "ai", args), detail ? ui.text(` - ${detail}\n`) : ui.text("\n"));
  return ui.concat(
    ui.bold("🤖 AI 助手"), ui.text("\n\n"),
    ui.bold("API 配置"), ui.text("\n"),
    line("config add tag url key [type]"), line("config del tag"), line("config list"),
    line("config type tag type"), line("config stream tag on|off"), line("config responses tag on|off"),
    ui.text("\n"), ui.bold("模型与请求"), ui.text("\n"),
    line("model chat|search tag model"),
    line("reasoning chat|search auto|none|minimal|low|medium|high|xhigh"),
    line("service chat|search auto|default|priority|fast|flex"),
    line("search 问题"), line("问题", "或回复文字后使用"),
    line("image 提示词", "生成图片；回复图片可编辑"), line("video [first|firstlast] 提示词", "生成视频"),
    ui.text("\n"), ui.bold("输出设置"), ui.text("\n"),
    line("prompt set 内容 / prompt del"), line("collapse on|off"), line("timeout 秒数"),
    line("image preview on|off"), line("video preview|audio on|off"), line("video duration 5-20"),
    line("telegraph on|off|limit 数量|del all"),
  );
}

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

async function sourceText(invocation: CommandInvocation, ctx: PluginContext, offset = 0): Promise<string> {
  const own = invocation.args.slice(offset).join(" ").trim();
  if (own) return own;
  return (await ctx.telegram.getReply(invocation.message))?.text.trim() ?? "";
}

async function configure(invocation: CommandInvocation, ctx: PluginContext): Promise<void> {
  const [action = "list", tag = "", value = "", type = ""] = invocation.args.slice(1);
  if (action === "list") {
    await ctx.telegram.edit(invocation.message, visibleConfig(await readConfig(ctx)), htmlOptions);
    return;
  }
  if (action === "add") {
    const url = value;
    const key = invocation.args[4] ?? "";
    const selectedType = invocation.args[5];
    requireInput(tag && url && key, "用法：ai config add tag url key [type]");
    requireInput(invocation.message.saved, "API Key 只能在收藏夹中配置");
    new URL(url);
    if (selectedType) requireInput(providerTypes.includes(selectedType as typeof providerTypes[number]), "无效 API 类型");
    await updateConfig(ctx, raw => {
      const configs = raw.configs && typeof raw.configs === "object" && !Array.isArray(raw.configs) ? raw.configs as Record<string, unknown> : {};
      configs[tag] = {tag, url, key, ...(selectedType ? {type: selectedType} : {}), stream: false, responses: false};
      raw.configs = configs;
    });
  } else if (action === "del") {
    requireInput(tag, "用法：ai config del tag");
    await updateConfig(ctx, raw => {
      const configs = {...(raw.configs as Record<string, unknown> ?? {})};
      delete configs[tag]; raw.configs = configs;
      for (const mode of modes) if (raw[`current${mode}Tag`] === tag) {
        raw[`current${mode}Tag`] = ""; raw[`current${mode}Model`] = "";
      }
    });
  } else if (["type", "stream", "responses"].includes(action)) {
    requireInput(tag && value, `用法：ai config ${action} tag value`);
    await updateConfig(ctx, (raw, cfg) => {
      const current = cfg.configs[tag]; requireInput(current, "API 配置不存在");
      if (action === "type") requireInput(providerTypes.includes(value as typeof providerTypes[number]), "无效 API 类型");
      const next = action === "type" ? value : bool(value);
      raw.configs = {...(raw.configs as Record<string, unknown>), [tag]: {...current, [action]: next}};
    });
  } else throw new InputError("未知 config 子命令");
  await ctx.telegram.edit(invocation.message, feedback("success", "AI 配置已更新"), htmlOptions);
}

async function setModel(invocation: CommandInvocation, ctx: PluginContext): Promise<void> {
  const [mode = "", tag = "", model = ""] = invocation.args.slice(1);
  requireInput(["chat", "search", "image", "video"].includes(mode) && tag && model, "用法：ai model chat|search|image|video tag model");
  assertAllowedModel(model);
  await updateConfig(ctx, (raw, cfg) => {
    requireInput(cfg.configs[tag], "API 配置不存在");
    raw[modeKey(mode, "Tag")] = tag; raw[modeKey(mode, "Model")] = model;
  });
  await ctx.telegram.edit(invocation.message, feedback("success", `${mode} 模型已设置`), htmlOptions);
}

async function setEnum(invocation: CommandInvocation, ctx: PluginContext, kind: "reasoning" | "service"): Promise<void> {
  const [mode = "", value = ""] = invocation.args.slice(1);
  requireInput(["chat", "search"].includes(mode), `用法：ai ${kind} chat|search value`);
  const values = kind === "reasoning" ? reasoningValues : tierValues;
  requireInput(values.includes(value as never), "无效选项");
  await updateConfig(ctx, raw => { raw[modeKey(mode, kind === "reasoning" ? "ReasoningEffort" : "ServiceTier")] = value; });
  await ctx.telegram.edit(invocation.message, feedback("success", `${kind} 已设置为 ${value}`), htmlOptions);
}

async function setOutput(invocation: CommandInvocation, ctx: PluginContext): Promise<boolean> {
  const [sub = "", value = ""] = invocation.args;
  if (sub === "prompt") {
    const action = value.toLowerCase();
    requireInput(action === "set" || action === "del", "用法：ai prompt set 内容 | ai prompt del");
    const prompt = action === "set" ? invocation.args.slice(2).join(" ").trim() : "";
    requireInput(action === "del" || prompt, "提示词不能为空");
    await updateConfig(ctx, raw => { raw.prompt = prompt; });
  } else if (sub === "collapse") {
    await updateConfig(ctx, raw => { raw.collapse = bool(value); });
  } else if (sub === "timeout") {
    const seconds = Number(value); requireInput(Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 600, "超时范围为 1-600 秒");
    await updateConfig(ctx, raw => { raw.timeout = seconds; });
  } else if (sub === "telegraph") {
    const action = value.toLowerCase();
    await updateConfig(ctx, raw => {
      const current = raw.telegraph && typeof raw.telegraph === "object" && !Array.isArray(raw.telegraph) ? raw.telegraph as Record<string, unknown> : {};
      if (action === "on" || action === "off") raw.telegraph = {...current, enabled: bool(action)};
      else if (action === "limit") {
        const limit = Number(invocation.args[2]); requireInput(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "记录容量范围为 1-100");
        raw.telegraph = {...current, limit};
      } else if (action === "del" && invocation.args[2] === "all") raw.telegraph = {...current, list: []};
      else throw new InputError("用法：ai telegraph on|off|limit 数量|del all");
    });
  } else return false;
  await ctx.telegram.edit(invocation.message, feedback("success", "AI 输出设置已更新"), htmlOptions);
  return true;
}

async function ask(invocation: CommandInvocation, ctx: PluginContext): Promise<void> {
  const search = invocation.args[0]?.toLowerCase() === "search";
  const question = await sourceText(invocation, ctx, search ? 1 : 0);
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
  const action = invocation.args[1]?.toLowerCase() ?? "";
  if (action === "preview" || kind === "video" && action === "audio") {
    const value = invocation.args[2]?.toLowerCase() ?? "";
    requireInput(value === "on" || value === "off", `用法：ai ${kind} ${action} on|off`);
    await updateConfig(ctx, raw => {raw[action === "preview" ? `${kind}Preview` : "videoAudio"] = value === "on";});
    await ctx.telegram.edit(invocation.message, feedback("success", `${kind} ${action} 已设置为 ${value}`), htmlOptions); return;
  }
  if (kind === "video" && action === "duration") {
    const seconds = Number(invocation.args[2]);
    requireInput(Number.isSafeInteger(seconds) && seconds >= 5 && seconds <= 20, "视频时长范围为 5-20 秒");
    await updateConfig(ctx, raw => {raw.videoDuration = seconds;});
    await ctx.telegram.edit(invocation.message, feedback("success", `视频时长已设置为 ${seconds} 秒`), htmlOptions); return;
  }
  const mode = kind === "video" && (action === "first" || action === "firstlast") ? action : "auto";
  const offset = mode === "auto" ? 1 : 2;
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

async function handle(invocation: CommandInvocation, ctx: PluginContext): Promise<void> {
  try {
    const sub = invocation.args[0]?.toLowerCase() ?? "";
    if (sub === "help" || sub === "?") await ctx.telegram.edit(invocation.message, help(invocation.prefix), htmlOptions);
    else if (sub === "config") await configure(invocation, ctx);
    else if (sub === "model") await setModel(invocation, ctx);
    else if (sub === "reasoning" || sub === "service") await setEnum(invocation, ctx, sub);
    else if (sub === "image" || sub === "video") await media(invocation, ctx, sub);
    else if (!await setOutput(invocation, ctx)) await ask(invocation, ctx);
  } catch (error) {
    if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message,
      feedback("error", "AI 操作失败", safeMessage(error), "检查配置、API 可用性和网络后重试"), htmlOptions);
  }
}

function serviceText(input: unknown): {text: string; systemPrompt?: string} {
  if (typeof input === "string") return {text: input};
  requireInput(input !== null && typeof input === "object" && !Array.isArray(input), "服务输入无效");
  const value = input as Record<string, unknown>;
  requireInput(typeof value.text === "string" && value.text.trim(), "服务文本不能为空");
  requireInput(value.systemPrompt === undefined || typeof value.systemPrompt === "string", "系统提示词无效");
  return {text: value.text, ...(typeof value.systemPrompt === "string" ? {systemPrompt: value.systemPrompt} : {})};
}

export default function createAi() {
  return definePlugin({apiVersion: 1, id: "ai", description: "AI 对话、搜索、媒体生成与配置", renderHelp: renderPluginHelp, settings,
    commands: {ai: {helpArgs: ["help","?"], description: "AI 对话、搜索与配置", handle}},
    services: {
      chat: {description: "使用当前聊天模型生成文字", async handle(input, ctx, signal) {
        const value = serviceText(input); const cfg = await readConfig(ctx, signal);
        return chatText(cfg, ctx.http, value.text, signal, value.systemPrompt ?? cfg.prompt);
      }},
      translate: {description: "使用当前聊天模型翻译文字", async handle(input, ctx, signal) {
        requireInput(input !== null && typeof input === "object" && !Array.isArray(input), "翻译输入无效");
        const value = input as Record<string, unknown>;
        requireInput(typeof value.text === "string" && value.text.trim(), "翻译文本不能为空");
        requireInput(value.target === "zh-CN" || value.target === "en", "翻译语言无效");
        return translateText(await readConfig(ctx, signal), ctx.http, value.text, value.target, signal);
      }},
    },
  });
}
