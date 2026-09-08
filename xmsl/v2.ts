import {renderHelp as renderPluginHelp} from "./v2/help";
import {access, open, readFile, stat} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";

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

function help(prefix: string): string {
  return `<b>羡慕死了</b>\n<code>${escape(prefix)}xmsl 内容</code> / <code>${escape(prefix)}xm 内容</code>\n` +
    `可回复文字、图片或贴纸。\n<code>${escape(prefix)}xm set mode openai|gemini</code>\n` +
    `<code>${escape(prefix)}xm set key API_KEY</code>（仅收藏夹）\n<code>${escape(prefix)}xm set url 地址</code> · <code>model 模型</code>\n<code>${escape(prefix)}xm show</code>`;
}

async function configure(context: PluginContext, invocation: any): Promise<boolean> {
  const [action, rawKey, ...rest] = invocation.args; if (action?.toLowerCase() !== "set") return false;
  const key = rawKey?.toLowerCase(), value = rest.join(" ").trim();
  if (!key || !value || !["mode","key","url","model"].includes(key)) { await context.telegram.edit(invocation.message, `用法：${invocation.prefix}xm set mode|key|url|model 值`); return true; }
  if (key === "key" && !invocation.message.saved) { await context.telegram.edit(invocation.message, "API Key 仅允许在收藏夹中设置"); return true; }
  try {
    if (key === "mode" && !["openai","gemini"].includes(value.toLowerCase())) throw new Error("invalid_mode");
    await store(context).update(current => applyPatch(current, {
      ...(key === "mode" ? {apiMode: value.toLowerCase() as Mode} : {}), ...(key === "key" ? {apiKey: value} : {}),
      ...(key === "url" ? {baseUrl: value} : {}), ...(key === "model" ? {model: value} : {})}));
    await context.telegram.edit(invocation.message, `${key} 已更新`); return true;
  } catch { await context.telegram.edit(invocation.message, "配置值无效"); return true; }
}

async function handle(invocation: any, context: PluginContext): Promise<void> {
  try {
    if (await configure(context, invocation)) return;
    const state = normalize(await store(context).read());
    const first = invocation.args[0]?.toLowerCase();
    if (first === "help") { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    if (first === "show" || (!invocation.args.length && invocation.message.replyToId === undefined)) {
      await context.telegram.edit(invocation.message, `<b>XMSL 状态</b>\n模式：${state.apiMode}\n密钥：${state.apiKey ? "已配置" : "未配置"}\n地址：<code>${escape(state.baseUrl)}</code>\n模型：<code>${escape(state.model)}</code>`, {parseMode: "html"}); return;
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

export default function createXmsl() {
  const command = {description: "生成羡慕调侃短句", ignoreEdited: true, handle};
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "xmsl", description: "使用 OpenAI 或 Gemini 生成羡慕调侃短句",
    resources: {processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 90_000, maxOutputBytes: 256 * 1024}},
    commands: {xmsl: {...command, helpArgs: ["help"]}, xm: {...command, helpArgs: ["help"]}}, setup: migrate,
    settings: context => ({id: "xmsl", title: "XMSL", description: "羡慕短句模型配置", category: "插件配置", icon: "🤢",
      getSchema: () => [{key:"apiMode",label:"API 模式",type:"select",options:[{label:"OpenAI",value:"openai"},{label:"Gemini",value:"gemini"}]},
        {key:"apiKey",label:"API Key",type:"password",secret:true},{key:"baseUrl",label:"API 地址",type:"string",required:true},{key:"model",label:"模型",type:"string",required:true}],
      getValues: () => store(context).read(), setValues: async patch => { await store(context).update(current => applyPatch(current, patch)); }}),
  });
}
