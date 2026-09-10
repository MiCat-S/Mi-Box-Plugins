import {access, open, readFile, stat} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";

type Mode = "openai" | "gemini";
type State = {schemaVersion: 1; apiMode: Mode; baseUrl: string; apiKey: string; model: string; importedLegacy: boolean; [key: string]: unknown};
type Image = {mimeType: string; base64: string};

const DEFAULTS: State = {schemaVersion: 1, apiMode: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4", importedLegacy: false};
const MAX_MEDIA = 20 * 1024 * 1024;
const MAX_INPUT = 50_000;
const MAX_RESPONSE = 1024 * 1024;
const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const PYTHON = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"] as const;
const SYSTEM_PROMPT = `你的任务是对用户的内容（文字或图片）做出一句“羡慕 + 调侃式的称呼或短语”的回复。输出永远只有一句“羡慕XXX”；XXX 来自用户内容中可轻松调侃的点。使用口语、俚语和轻松风格，2～4 个字优先；不要解释、分析、提问或重复原句。`;
const TGS_SCRIPT = `import sys\nfrom rlottie_python import LottieAnimation\nanim=LottieAnimation.from_tgs(sys.argv[1])\nanim.save_animation(sys.argv[2])\n`;

const escape = (value: unknown) => String(value ?? "").replace(/[&<>\"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#x27;"})[character]!);
const store = (context: PluginContext) => context.storage.json<State>("config.json", DEFAULTS);

function apiRoot(value: unknown): URL {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new Error("invalid_url");
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("invalid_url");
  return url;
}

function normalize(value: Partial<State>): State {
  const apiMode: Mode = value.apiMode === "gemini" ? "gemini" : "openai";
  let baseUrl = DEFAULTS.baseUrl;
  try { baseUrl = apiRoot(typeof value.baseUrl === "string" ? value.baseUrl : DEFAULTS.baseUrl).toString().replace(/\/$/, ""); }
  catch { /* A malformed legacy URL must not prevent the plugin from loading. */ }
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim().slice(0, 200) : DEFAULTS.model;
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim().slice(0, 4096) : "";
  return {...value, schemaVersion: 1, apiMode, baseUrl, apiKey, model, importedLegacy: true};
}

function applyPatch(current: State, patch: Record<string, unknown>): State {
  if (patch.apiMode !== undefined && patch.apiMode !== "openai" && patch.apiMode !== "gemini") throw new Error("invalid_mode");
  if (patch.apiKey !== undefined && (typeof patch.apiKey !== "string" || patch.apiKey.length > 4096)) throw new Error("invalid_key");
  if (patch.baseUrl !== undefined) apiRoot(patch.baseUrl);
  if (patch.model !== undefined && (typeof patch.model !== "string" || !patch.model.trim() || patch.model.length > 200)) throw new Error("invalid_model");
  return normalize({...current, ...patch});
}

async function migrate(context: PluginContext): Promise<void> {
  await store(context).update(current => normalize(current));
}

function imageMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x89,0x50,0x4e,0x47]))) return "image/png";
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
}

async function helper(context: PluginContext, candidates: readonly string[], args: readonly string[]): Promise<void> {
  for (const command of candidates) {
    try {
      await context.processes.run(command, args, {timeoutMs: 90_000, maxOutputBytes: 256 * 1024});
      return;
    } catch (error) {
      context.signal.throwIfAborted();
      if ((error as {code?: unknown})?.code !== "SPAWN_FAILED") throw error;
      try { await access(command, constants.F_OK); } catch { continue; }
      throw error;
    }
  }
  throw new Error("helper_unavailable");
}

async function download(context: PluginContext, raw: any, target: string, thumb?: number): Promise<Buffer> {
  await context.telegram.withClient(async (client: any, signal) => {
    const file = await open(target, "wx", 0o600);
    let total = 0;
    try {
      for await (const chunk of client.iterDownload(raw.media, thumb === undefined ? {} : {thumb})) {
        signal.throwIfAborted();
        total += chunk.length;
        if (total > MAX_MEDIA) throw new Error("media_too_large");
        await file.write(chunk);
      }
      if (!total) throw new Error("empty_media");
    } finally { await file.close(); }
  });
  return readFile(target);
}

async function boundedFile(file: string, maximum = MAX_MEDIA): Promise<Buffer> {
  const info = await stat(file);
  if (!info.isFile() || info.size <= 0 || info.size > maximum) throw new Error("converted_media_too_large");
  return readFile(file);
}

async function mediaImage(context: PluginContext, message: MessageEnvelope): Promise<Image | undefined> {
  const raw: any = message.raw;
  if (!raw?.media) return;
  return context.files.withTemp(async (directory, signal) => {
    const mime = String(raw.media?.document?.mimeType ?? (raw.media?.photo || raw.photo ? "image/jpeg" : ""));
    const sticker = Boolean(raw.media?.document?.attributes?.some((item: any) => item?.className === "DocumentAttributeSticker" || item?.constructor?.name === "DocumentAttributeSticker"));
    if (!mime.startsWith("image/") && mime !== "video/webm" && mime !== "application/x-tgsticker" && !sticker) return;
    const input = path.join(directory, mime === "video/webm" ? "input.webm" : mime === "application/x-tgsticker" ? "input.tgs" : "input.bin");
    let buffer = await download(context, raw, input);
    signal.throwIfAborted();
    if (mime === "video/webm") {
      const output = path.join(directory, "frame.png");
      await helper(context, FFMPEG, ["-nostdin", "-y", "-i", input, "-frames:v", "1", output]);
      buffer = await boundedFile(output);
    } else if (mime === "application/x-tgsticker") {
      const gif = path.join(directory, "animation.gif"), output = path.join(directory, "frame.png");
      await helper(context, PYTHON, ["-c", TGS_SCRIPT, input, gif]);
      await boundedFile(gif, 64 * 1024 * 1024);
      await helper(context, FFMPEG, ["-nostdin", "-y", "-i", gif, "-frames:v", "1", output]);
      buffer = await boundedFile(output);
    } else if (!imageMime(buffer) && sticker) {
      const thumb = path.join(directory, "thumb.bin");
      buffer = await download(context, raw, thumb, 1);
    }
    const detected = imageMime(buffer);
    if (!detected) throw new Error("unsupported_media");
    return {mimeType: detected, base64: buffer.toString("base64")};
  });
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<any> {
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted(); const item = await reader.read(); if (item.done) break;
      total += item.value.length; if (total > MAX_RESPONSE) throw new Error("response_too_large"); chunks.push(Buffer.from(item.value));
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!response.ok) throw new Error(`http_${response.status}`);
  try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")); } catch { throw new Error("invalid_json"); }
}

function endpoint(config: State): URL {
  const url = apiRoot(config.baseUrl);
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = config.apiMode === "gemini" ? `${base}/models/${encodeURIComponent(config.model)}:generateContent` : `${base}/chat/completions`;
  return url;
}

async function generate(context: PluginContext, config: State, text: string, image?: Image): Promise<string> {
  const url = endpoint(config);
  const body = config.apiMode === "gemini" ? {
    contents: [{parts: [{text: text || "请识别这张图片/贴纸的内容"}, ...(image ? [{inlineData: {mimeType: image.mimeType, data: image.base64}}] : [])]}],
    systemInstruction: {parts: [{text: SYSTEM_PROMPT}]}, generationConfig: {temperature: 0.7},
  } : {
    model: config.model, temperature: 0.7, messages: [{role: "system", content: SYSTEM_PROMPT}, {role: "user", content: image ? [
      {type: "text", text: text || "请识别这张图片/贴纸的内容"}, {type: "image_url", image_url: {url: `data:${image.mimeType};base64,${image.base64}`}},
    ] : text}],
  };
  const headers: Record<string,string> = {"content-type": "application/json"};
  headers[config.apiMode === "gemini" ? "x-goog-api-key" : "authorization"] = config.apiMode === "gemini" ? config.apiKey : `Bearer ${config.apiKey}`;
  const data = await context.http.withResponse(url, {method: "POST", redirect: "manual", credentials: "omit", headers, body: JSON.stringify(body)}, boundedJson,
    {timeoutMs: 60_000, signal: context.signal, redirects: {allowedHosts: [url.hostname], maxRedirects: 2}});
  const answer = config.apiMode === "gemini" ? data?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? "").join("") : data?.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) throw new Error("empty_answer");
  const withoutThink = answer.includes("</think>") ? answer.slice(answer.lastIndexOf("</think>") + 8).trim() : answer.trim();
  return withoutThink.length > 16_000 ? `${withoutThink.slice(0, 1000)}…` : withoutThink;
}

const guarded = (operation: CommandDefinition["handle"]): CommandDefinition["handle"] => async (invocation, context) => {
  try { await operation(invocation, context); }
  catch {
    if (context.signal.aborted) return;
    context.log.error("xmsl_failed");
    await context.telegram.edit(invocation.message, "XMSL 调用失败，请检查配置、媒体依赖和网络");
  }
};
const configure = (key: "mode" | "key" | "url" | "model"): CommandDefinition["handle"] => guarded(async (invocation, context) => {
  const value = invocation.args.join(" ").trim();
  if (!key || !value || !["mode","key","url","model"].includes(key)) { await context.telegram.edit(invocation.message, `用法：${invocation.prefix}xm set mode|key|url|model 值`); return; }
  if (key === "key" && !invocation.message.saved) { await context.telegram.edit(invocation.message, "API Key 仅允许在收藏夹中设置"); return; }
  try {
    if (key === "mode" && !["openai","gemini"].includes(value.toLowerCase())) throw new Error("invalid_mode");
    await store(context).update(current => applyPatch(current, {
      ...(key === "mode" ? {apiMode: value.toLowerCase() as Mode} : {}), ...(key === "key" ? {apiKey: value} : {}),
      ...(key === "url" ? {baseUrl: value} : {}), ...(key === "model" ? {model: value} : {})}));
    await context.telegram.edit(invocation.message, `${key} 已更新`); return;
  } catch { await context.telegram.edit(invocation.message, "配置值无效"); return; }
});

async function showState(invocation: Parameters<CommandDefinition["handle"]>[0], context: PluginContext, state: State): Promise<void> {
      await context.telegram.edit(invocation.message, `<b>XMSL 状态</b>\n模式：${state.apiMode}\n密钥：${state.apiKey ? "已配置" : "未配置"}\n地址：<code>${escape(state.baseUrl)}</code>\n模型：<code>${escape(state.model)}</code>`, {parseMode: "html"});
}

async function handle(invocation: any, context: PluginContext): Promise<void> {
  try {
    const state = normalize(await store(context).read());
    const first = invocation.args[0]?.toLowerCase();
    if (first === "help") { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    if (!invocation.args.length && invocation.message.replyToId === undefined) {
      await showState(invocation, context, state); return;
    }
    if (!state.apiKey) { await context.telegram.edit(invocation.message, "未配置 API Key，请先在收藏夹中设置"); return; }
    let text = invocation.args.join(" ").trim(), image: Image | undefined;
    if (!text && invocation.message.replyToId !== undefined) {
      const reply = await context.telegram.getReply(invocation.message);
      if (reply) { text = reply.text.trim(); image = await mediaImage(context, reply); }
    }
    if (!text && !image) { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    if (text.length > MAX_INPUT) { await context.telegram.edit(invocation.message, "输入内容过长"); return; }
    await context.telegram.edit(invocation.message, image ? "正在识别图片…" : "处理中…");
    await context.telegram.edit(invocation.message, await generate(context, state, text, image));
  } catch {
    if (context.signal.aborted) return;
    context.log.error("xmsl_failed");
    await context.telegram.edit(invocation.message, "XMSL 调用失败，请检查配置、媒体依赖和网络");
  }
}

  const command: CommandDefinition = {
    description: "生成羡慕调侃短句", ignoreEdited: true, helpArgs: ["help"], args: "[内容]", subcommandsCaseSensitive: false,
    examples: [{args: "今天吃大餐"}, {args: "", description: "回复文字、图片或贴纸生成短句；无回复时查看状态"}],
    subcommands: {
      set: {description: "修改模型配置", subcommands: {
        mode: {description: "设置接口模式", args: "openai|gemini", examples: [{args: "mode gemini"}], handle: configure("mode")},
        key: {description: "设置 API 密钥，仅收藏夹", args: "API_KEY", handle: configure("key")},
        url: {description: "设置 HTTPS API 基础地址", args: "地址", help: [{body: "OpenAI 模式地址应包含 /v1；Gemini 模式地址应包含 /v1beta。地址不能带查询参数、片段或内嵌凭据。"}], handle: configure("url")},
        model: {description: "设置模型名称", args: "模型", handle: configure("model")},
      }, handle: guarded(async (i, context) => { await context.telegram.edit(i.message, `用法：${i.prefix}xm set mode|key|url|model 值`); })},
      show: {description: "查看模式、地址、模型及密钥是否配置", args: "", async handle(i, context) {
        try { await showState(i, context, normalize(await store(context).read())); }
        catch { if (!context.signal.aborted) { context.log.error("xmsl_failed"); await context.telegram.edit(i.message, "XMSL 调用失败，请检查配置、媒体依赖和网络"); } }
      }},
    },
    help: [{heading: "图片和贴纸：", body: "支持 JPEG/PNG/GIF/WebP、WebM 视频贴纸和 TGS 动态贴纸。WebM 需要 FFmpeg；TGS 需要 Python、rlottie-python 和 FFmpeg，读取首帧。媒体最多 20 MiB，文本最多 50000 字符。"},
      {heading: "命令别名：", body: "<code>{prefix}xm</code> 与 <code>{prefix}xmsl</code> 使用相同参数。密钥只在收藏夹设置，状态页仅显示是否已配置。"}],
    handle,
  };
const help = (prefix: string) => renderCommandHelp("xmsl", command, {prefix, title: "🤢 羡慕死了"});
export default function createXmsl() {
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "xmsl", description: "使用 OpenAI 或 Gemini 生成羡慕调侃短句",
    resources: {processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 90_000, maxOutputBytes: 256 * 1024}},
    commands: {xmsl: command, xm: command}, setup: migrate,
    settings: context => ({id: "xmsl", title: "XMSL", description: "羡慕短句模型配置", category: "插件配置", icon: "🤢",
      getSchema: () => [{key:"apiMode",label:"API 模式",type:"select",options:[{label:"OpenAI",value:"openai"},{label:"Gemini",value:"gemini"}]},
        {key:"apiKey",label:"API Key",type:"password",secret:true},{key:"baseUrl",label:"API 地址",type:"string",required:true},{key:"model",label:"模型",type:"string",required:true}],
      getValues: () => store(context).read(), setValues: async patch => { await store(context).update(current => applyPatch(current, patch)); }}),
  });
}
