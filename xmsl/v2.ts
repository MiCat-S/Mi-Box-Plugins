import {lstat, open, readFile, type FileHandle} from "node:fs/promises";
import path from "node:path";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin, type MessageEnvelope, type PluginContext, ui} from "telebox/sdk";

type Mode = "openai" | "gemini";
type State = {schemaVersion: 1; apiMode: Mode; baseUrl: string; apiKey: string; model: string; importedLegacy: boolean; aiMigrated?: boolean; [key: string]: unknown};
type Image = {mimeType: string; data: Buffer};

const DEFAULTS: State = {schemaVersion: 1, apiMode: "openai", baseUrl: "", apiKey: "", model: "", importedLegacy: true, aiMigrated: true};
const MAX_MEDIA = 20 * 1024 * 1024;
const MAX_INPUT = 50_000;
const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const PYTHON = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"] as const;
const SYSTEM_PROMPT = `你的任务是对用户的内容（文字或图片）做出一句"羡慕 + 调侃式的称呼或短语"的回复。

规则（调侃版本）：

1. 输出永远只有一句话："羡慕XXX"。
2. XXX 必须是来自用户内容的"可以被轻松调侃"的点。
3. 如果用户发送图片，请识别图片内容并找到可以调侃的点。
4. 不要书面语言，不要抽象词汇，用口语、俚语、小坏笑的风格，比如：
   - "富哥"
   - "狠人"
   - "老整活"
   - "会玩"
   - "大聪明"
   - "神仙操作"
   - "小日子"
5. 回复越短越好，2～4 个字优先。
6. 回复带点调侃，不要太认真，也不要太过火。
7. 负面内容也可以轻轻调侃：
   - 倒霉 → "霉神"
   - 加班 → "打工魂"
   - 心情差 → "情绪达人"
8. 不要解释，不要分析，不要问问题，不要重复用户原句。

示例（只是风格参考）：
用户：我今天吃寿司。
你：羡慕会享受

用户：我下午要加班。
你：羡慕打工魂

用户：我今天心情不好。
你：羡慕情绪达人

用户：我买新手机了。
你：羡慕富哥

用户：[一张豪华跑车图片]
你：羡慕富哥

用户：[一张可爱猫咪贴纸]
你：羡慕猫奴

用户：[一张美食图片]
你：羡慕会吃`;
const TGS_SCRIPT = `import sys\nfrom rlottie_python import LottieAnimation\nanim=LottieAnimation.from_tgs(sys.argv[1])\nanim.save_animation(sys.argv[2])\n`;

export async function writeAll(file: Pick<FileHandle, "write">, chunk: Uint8Array, signal: AbortSignal): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    signal.throwIfAborted();
    const result = await file.write(chunk, offset, chunk.byteLength - offset);
    signal.throwIfAborted();
    if (result.bytesWritten <= 0) throw new Error("media_write_failed");
    offset += result.bytesWritten;
  }
}

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
  let baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : "";
  try { if (baseUrl) baseUrl = apiRoot(baseUrl).toString().replace(/\/$/, ""); }
  catch { /* A malformed legacy URL must not prevent the plugin from loading. */ }
  const model = typeof value.model === "string" ? value.model.trim().slice(0, 200) : "";
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim().slice(0, 4096) : "";
  return {...value, schemaVersion: 1, apiMode, baseUrl, apiKey, model, importedLegacy: true, aiMigrated: value.aiMigrated === true};
}

async function migrate(context: PluginContext): Promise<void> {
  const current = normalize(await store(context).read()); context.signal.throwIfAborted();
  if (current.aiMigrated) return;
  if (!current.apiKey) {
    await store(context).update(value => ({...normalize(value), baseUrl: "", model: "", aiMigrated: true})); context.signal.throwIfAborted();
    return;
  }
  if (!context.services.available("ai", "import_provider")) return;
  try { apiRoot(current.baseUrl); } catch { return; }
  if (!current.model) return;
  await context.services.call("ai", "import_provider", {tag: "xmsl", url: current.baseUrl, key: current.apiKey,
    type: current.apiMode === "gemini" ? "gemini" : "openai-compatible", models: {chat: current.model}, select: ["chat"]}, context.signal);
  context.signal.throwIfAborted();
  await store(context).update(value => ({...normalize(value), apiKey: "", baseUrl: "", model: "", aiMigrated: true})); context.signal.throwIfAborted();
}

function imageMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x89,0x50,0x4e,0x47]))) return "image/png";
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
}

async function helper(context: PluginContext, directory: string, signal: AbortSignal, candidates: readonly string[], args: readonly string[]): Promise<void> {
  for (const command of candidates) {
    try {
      signal.throwIfAborted();
      await context.processes.run(command, args, {cwd: directory, env: {}, signal, timeoutMs: 90_000, maxOutputBytes: 256 * 1024});
      signal.throwIfAborted();
      return;
    } catch (error) {
      signal.throwIfAborted();
      if ((error as {code?: unknown})?.code !== "SPAWN_FAILED") throw error;
      continue;
    }
  }
  throw new Error("helper_unavailable");
}

export async function download(context: PluginContext, raw: any, target: string, callerSignal: AbortSignal, thumb?: number): Promise<Buffer> {
  await context.telegram.withClient(async (client: any, clientSignal) => {
    const signal = AbortSignal.any([context.signal, callerSignal, clientSignal]); signal.throwIfAborted();
    const file = await open(target, "wx", 0o600);
    let total = 0;
    try {
      signal.throwIfAborted();
      for await (const chunk of client.iterDownload(raw.media, {...(thumb === undefined ? {} : {thumb}), signal})) {
        signal.throwIfAborted();
        total += chunk.length;
        if (total > MAX_MEDIA) throw new Error("media_too_large");
        await writeAll(file, chunk, signal);
      }
      if (!total) throw new Error("empty_media");
    } finally { await file.close(); }
  });
  callerSignal.throwIfAborted(); const value = await readFile(target, {signal: callerSignal}); callerSignal.throwIfAborted(); return value;
}

async function boundedFile(file: string, signal: AbortSignal, maximum = MAX_MEDIA): Promise<Buffer> {
  signal.throwIfAborted(); const info = await lstat(file); signal.throwIfAborted();
  if (!info.isFile() || info.size <= 0 || info.size > maximum) throw new Error("converted_media_too_large");
  const value = await readFile(file, {signal}); signal.throwIfAborted(); return value;
}

function resultPages(value: string): string[] {
  const chunks: string[] = []; let current = "";
  for (const character of value) {
    const encoded = escape(character);
    if (current && current.length + encoded.length > 3500) { chunks.push(current); current = ""; }
    current += encoded;
  }
  if (current || !chunks.length) chunks.push(current);
  if (chunks.length === 1) return chunks;
  return chunks.map((chunk, index) => chunk + ui.pageLabel(index, chunks.length));
}

async function deliverResult(invocation: any, context: PluginContext, value: string): Promise<void> {
  const delivery = await ui.deliverPages(resultPages(value), context.signal, (page, index) => index === 0
    ? context.telegram.edit(invocation.message, page, {parseMode: "html"})
    : context.telegram.reply(invocation.message, page, {parseMode: "html"}));
  if (!delivery.interrupted) return;
  if (delivery.published) {
    context.log.error("xmsl_delivery_interrupted");
    try { await context.telegram.reply(invocation.message, ui.interruptedNotice(delivery)); }
    catch { context.signal.throwIfAborted(); context.log.error("xmsl_delivery_notice_failed"); }
    return;
  }
  context.log.error("xmsl_delivery_failed");
  try { await context.telegram.edit(invocation.message, "XMSL 结果发送失败，请重新执行"); }
  catch { context.signal.throwIfAborted(); context.log.error("xmsl_delivery_notice_failed"); }
}

async function mediaImage(context: PluginContext, message: MessageEnvelope): Promise<Image | undefined> {
  const raw: any = message.raw;
  if (!raw?.media) return;
  let produced: Image | undefined, tempSignal: AbortSignal | undefined;
  try { return await context.files.withTemp(async (directory, signal) => {
    tempSignal = signal;
    const mime = String(raw.media?.document?.mimeType ?? (raw.media?.photo || raw.photo ? "image/jpeg" : ""));
    const sticker = Boolean(raw.media?.document?.attributes?.some((item: any) => item?.className === "DocumentAttributeSticker" || item?.constructor?.name === "DocumentAttributeSticker"));
    if (!mime.startsWith("image/") && mime !== "video/webm" && mime !== "application/x-tgsticker" && !sticker) return;
    const input = path.join(directory, mime === "video/webm" ? "input.webm" : mime === "application/x-tgsticker" ? "input.tgs" : "input.bin");
    const active = AbortSignal.any([context.signal, signal]); active.throwIfAborted();
    let buffer = await download(context, raw, input, active);
    signal.throwIfAborted();
    if (mime === "video/webm") {
      const output = path.join(directory, "frame.png");
      await helper(context, directory, active, FFMPEG, ["-nostdin", "-y", "-protocol_whitelist", "file", "-i", input,
        "-frames:v", "1", "-fs", String(MAX_MEDIA), output]);
      buffer = await boundedFile(output, active);
    } else if (mime === "application/x-tgsticker") {
      const gif = path.join(directory, "animation.gif"), output = path.join(directory, "frame.png");
      await helper(context, directory, active, PYTHON, ["-c", TGS_SCRIPT, input, gif]);
      await boundedFile(gif, active, 64 * 1024 * 1024);
      await helper(context, directory, active, FFMPEG, ["-nostdin", "-y", "-protocol_whitelist", "file", "-i", gif,
        "-frames:v", "1", "-fs", String(MAX_MEDIA), output]);
      buffer = await boundedFile(output, active);
    } else if (!imageMime(buffer) && sticker) {
      const thumb = path.join(directory, "thumb.bin");
      buffer = await download(context, raw, thumb, active, 1);
    }
    const detected = imageMime(buffer);
    if (!detected) throw new Error("unsupported_media");
    produced = {mimeType: detected, data: buffer};
    return produced;
  }); } catch (error) {
    context.signal.throwIfAborted(); tempSignal?.throwIfAborted();
    if (produced) { context.log.error("xmsl_temp_cleanup_failed"); return produced; }
    throw error;
  }
}

const guarded = (operation: CommandDefinition["handle"]): CommandDefinition["handle"] => async (invocation, context) => {
  try { await operation(invocation, context); }
  catch {
    if (context.signal.aborted) return;
    context.log.error("xmsl_failed");
    await context.telegram.edit(invocation.message, "XMSL 调用失败，请检查配置、媒体依赖和网络");
  }
};
const configure: CommandDefinition["handle"] = async (invocation, context) => {
  await context.telegram.edit(invocation.message,
    `供应商与模型由 ai 插件统一管理，请使用 ${invocation.prefix}ai config 和 ${invocation.prefix}ai model chat。`);
};

async function showState(invocation: Parameters<CommandDefinition["handle"]>[0], context: PluginContext): Promise<void> {
  await migrate(context); context.signal.throwIfAborted();
  if (!context.services.available("ai", "selection")) {
    await context.telegram.edit(invocation.message, "请先安装并配置 ai 插件"); return;
  }
  const selection = await context.services.call<{chat?: {tag?: string; model?: string}}>("ai", "selection", null, context.signal);
  context.signal.throwIfAborted();
  await context.telegram.edit(invocation.message, `<b>XMSL 状态</b>\nAI：<code>${escape(selection.chat?.tag || "-")} / ${escape(selection.chat?.model || "-")}</code>`, {parseMode: "html"});
}

async function handle(invocation: any, context: PluginContext): Promise<void> {
  try {
    const first = invocation.args[0]?.toLowerCase();
    if (first === "help") { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    if (!invocation.args.length && invocation.message.replyToId === undefined) {
      await showState(invocation, context); return;
    }
    await migrate(context); context.signal.throwIfAborted();
    if (!context.services.available("ai", "chat")) { await context.telegram.edit(invocation.message, "请先安装并配置 ai 插件"); return; }
    let text = invocation.args.join(" ").trim(), image: Image | undefined;
    if (!text && invocation.message.replyToId !== undefined) {
      const reply = await context.telegram.getReply(invocation.message); context.signal.throwIfAborted();
      if (reply) {
        text = reply.text.trim();
        try { image = await mediaImage(context, reply); }
        catch {
          context.signal.throwIfAborted();
          const mime = String((reply.raw as any)?.media?.document?.mimeType ?? "");
          if (!text && (mime === "application/x-tgsticker" || mime === "video/webm")) {
            await context.telegram.edit(invocation.message, mime === "application/x-tgsticker"
              ? "TGS 贴纸转换失败，需要安装 rlottie-python 和 FFmpeg"
              : "WebM 贴纸转换失败，需要安装 FFmpeg");
            return;
          }
        }
      }
    }
    if (!text && !image) { await showState(invocation, context); return; }
    if (text.length > MAX_INPUT) { await context.telegram.edit(invocation.message, "输入内容过长"); return; }
    await context.telegram.edit(invocation.message, image ? "正在识别图片…" : "处理中…");
    const answer = await context.services.call<string>("ai", "chat", {text: text || "请识别这张图片/贴纸的内容",
      systemPrompt: SYSTEM_PROMPT, temperature: 0.7, ...(image ? {images: [image]} : {})}, context.signal);
    context.signal.throwIfAborted();
    const withoutThink = answer.includes("</think>") ? answer.slice(answer.lastIndexOf("</think>") + 8).trim() : answer.trim();
    if (!withoutThink) throw new Error("empty_answer");
    const estimatedTokens = Math.ceil(withoutThink.length / 4);
    await deliverResult(invocation, context, estimatedTokens > 4000
      ? `⚠️ 回复过长(${estimatedTokens} tokens, 超过限制4000)\n\n${withoutThink.slice(0, 1000)}...`
      : withoutThink);
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
      set: {description: "查看统一 AI 配置方式", handle: configure},
      show: {description: "查看模式、地址、模型及密钥是否配置", args: "", async handle(i, context) {
        try { await showState(i, context); }
        catch { if (!context.signal.aborted) { context.log.error("xmsl_failed"); await context.telegram.edit(i.message, "XMSL 调用失败，请检查配置、媒体依赖和网络"); } }
      }},
    },
    help: [{heading: "图片和贴纸：", body: "支持 JPEG/PNG/GIF/WebP、WebM 视频贴纸和 TGS 动态贴纸。WebM 需要 FFmpeg；TGS 需要 Python、rlottie-python 和 FFmpeg，读取首帧。媒体最多 20 MiB，文本最多 50000 字符。"},
      {heading: "AI 配置：", body: "<code>{prefix}xm</code> 与 <code>{prefix}xmsl</code> 使用相同参数。供应商、密钥与聊天模型由 ai 插件统一管理。"}],
    handle,
  };
const help = (prefix: string) => renderCommandHelp("xmsl", command, {prefix, title: "🤢 羡慕死了"});
export default function createXmsl() {
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "xmsl", description: "使用统一 AI 服务生成羡慕调侃短句",
    resources: {processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 90_000, maxOutputBytes: 256 * 1024}},
    commands: {xmsl: command, xm: command}, setup: migrate,
  });
}
