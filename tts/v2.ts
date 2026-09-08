import {renderHelp as renderPluginHelp} from "./v2/help";
import {open, stat} from "node:fs/promises";
import path from "node:path";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

type Config = {schemaVersion: 1; key: string; region: string; voice: string; style: string; rate: string; format: string; [key: string]: unknown};
type Voice = {ShortName: string; LocalName: string; Locale: string; Gender: string};

const DEFAULTS: Config = {schemaVersion: 1, key: "", region: "eastus", voice: "zh-CN-XiaoxiaoNeural", style: "", rate: "1.0", format: "audio-48khz-192kbitrate-mono-mp3"};
const REGIONS = new Set(["australiaeast", "brazilsouth", "canadacentral", "centralindia", "centralus", "eastasia", "eastus", "eastus2", "francecentral", "germanywestcentral", "japaneast", "japanwest", "koreacentral", "northcentralus", "northeurope", "norwayeast", "southafricanorth", "southcentralus", "southeastasia", "southindia", "swedencentral", "switzerlandnorth", "uaenorth", "uksouth", "westcentralus", "westeurope", "westindia", "westus", "westus2", "westus3"]);
const FORMATS = new Set(["audio-48khz-192kbitrate-mono-mp3", "audio-24khz-160kbitrate-mono-mp3", "audio-16khz-128kbitrate-mono-mp3", "riff-48khz-16bit-mono-pcm", "riff-24khz-16bit-mono-pcm", "riff-16khz-16bit-mono-pcm"]);
const MAX_AUDIO = 64 * 1024 * 1024;

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;"})[character]!);
const ssmlEscape = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const store = (context: PluginContext) => context.storage.json<Config>("config.json", DEFAULTS);

function normalize(value: Partial<Config>): Config {
  const region = typeof value.region === "string" && REGIONS.has(value.region.toLowerCase()) ? value.region.toLowerCase() : DEFAULTS.region;
  const rate = typeof value.rate === "string" && Number(value.rate) >= 0.5 && Number(value.rate) <= 2 ? value.rate : DEFAULTS.rate;
  const format = typeof value.format === "string" && FORMATS.has(value.format) ? value.format : DEFAULTS.format;
  const voice = typeof value.voice === "string" && /^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9-]{1,80}$/.test(value.voice) ? value.voice : DEFAULTS.voice;
  const style = typeof value.style === "string" && /^[A-Za-z0-9-]{0,40}$/.test(value.style) ? value.style : "";
  return {...value, schemaVersion: 1, key: typeof value.key === "string" ? value.key : "", region, voice, style, rate, format};
}

async function config(context: PluginContext): Promise<Config> {
  const current = await store(context).read(context.signal);
  if (current.schemaVersion === 1 && normalize(current).region === current.region && normalize(current).format === current.format) return normalize(current);
  return store(context).update(value => normalize(value), context.signal);
}

function clean(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/([，。？！、,?!.])\1+/g, "$1").trim().slice(0, 3000);
}

function endpoint(value: Config, route: string): {url: string; host: string} {
  if (!REGIONS.has(value.region)) throw new Error("Invalid region");
  const host = `${value.region}.tts.speech.microsoft.com`;
  return {url: `https://${host}/cognitiveservices/${route}`, host};
}

async function boundedJson(response: Response, signal: AbortSignal, maximum = 2 * 1024 * 1024): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("Azure request failed");
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let total = 0;
  try { while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; total += part.value.byteLength;
      if (total > maximum) throw new Error("Azure response too large"); chunks.push(Buffer.from(part.value)); } }
  finally { await reader.cancel().catch(() => undefined); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Invalid Azure response"); }
}

async function streamAudio(response: Response, target: string, signal: AbortSignal): Promise<void> {
  if (!response.ok || !response.body) throw new Error("Azure synthesis failed");
  const handle = await open(target, "wx", 0o600); const reader = response.body.getReader(); let total = 0;
  try { while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; total += part.value.byteLength;
      if (total > MAX_AUDIO) throw new Error("Azure audio too large"); await handle.write(part.value); } }
  finally { await reader.cancel().catch(() => undefined); await handle.close(); }
  if (!total) throw new Error("Empty Azure audio");
}

function help(prefix: string): string {
  const p = escape(prefix);
  return `<b>Azure TTS</b>\n<code>${p}tts &lt;文本&gt;</code>\n<code>${p}tts config &lt;key&gt; &lt;region&gt;</code>（仅收藏夹）\n<code>${p}tts voice &lt;VoiceName&gt;</code>\n<code>${p}tts style &lt;Style|clear&gt;</code>\n<code>${p}tts rate &lt;0.5~2.0&gt;</code>\n<code>${p}tts voices [filter]</code>\n<code>${p}tts list</code>`;
}

async function deleteCommand(invocation: any, context: PluginContext): Promise<void> {
  const raw = invocation.message.raw as ApiTypes.Message | undefined;
  if (!raw || typeof raw.delete !== "function") return;
  await raw.delete({revoke: invocation.message.saved || Boolean((raw as any).isPrivate)}).catch(() => undefined);
}

export default function createTts() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "tts", description: "Azure Speech 文字转语音",
    commands: {tts: {description: "合成语音并管理 Azure TTS 配置", async handle(invocation, context) {
      const sub = (invocation.args[0] ?? "").toLowerCase();
      const edit = (text: string, html = true) => context.telegram.edit(invocation.message, text, html ? {parseMode: "html"} : undefined);
      try {
        if (sub === "config") {
          if (!invocation.message.saved) { await edit("请仅在收藏夹中设置 Azure API Key", false); return; }
          const key = invocation.args[1] ?? "", region = (invocation.args[2] ?? "").toLowerCase();
          if (!key || !REGIONS.has(region)) { await edit(`用法：<code>${escape(invocation.prefix)}tts config &lt;key&gt; &lt;region&gt;</code>\nRegion 必须是受支持的 Azure Speech 区域`); return; }
          await store(context).update(value => normalize({...value, key, region}), context.signal);
          await edit(`配置已更新\nRegion：<code>${escape(region)}</code>`); return;
        }
        if (sub === "voice") {
          const voice = invocation.args[1] ?? ""; if (!/^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9-]{1,80}$/.test(voice)) { await edit("语音名称无效", false); return; }
          await store(context).update(value => normalize({...value, voice}), context.signal); await edit(`语音已设置为：<code>${escape(voice)}</code>`); return;
        }
        if (sub === "style") {
          const raw = invocation.args[1] ?? ""; const style = raw.toLowerCase() === "clear" ? "" : raw;
          if (!/^[A-Za-z0-9-]{0,40}$/.test(style)) { await edit("语音风格无效", false); return; }
          await store(context).update(value => normalize({...value, style}), context.signal); await edit(`风格已设置：<code>${escape(style || "默认")}</code>`); return;
        }
        if (sub === "rate") {
          const rate = invocation.args[1] ?? ""; if (!rate || !Number.isFinite(Number(rate)) || Number(rate) < 0.5 || Number(rate) > 2) { await edit("语速必须在 0.5 到 2.0 之间", false); return; }
          await store(context).update(value => normalize({...value, rate}), context.signal); await edit(`语速已设置：<code>${escape(rate)}</code>`); return;
        }
        const current = await config(context);
        if (sub === "list") {
          await edit(`<b>当前配置</b>\nKey：${current.key ? "已配置" : "未配置"}\nRegion：<code>${escape(current.region)}</code>\nVoice：<code>${escape(current.voice)}</code>\nStyle：<code>${escape(current.style || "默认")}</code>\nRate：<code>${escape(current.rate)}</code>`); return;
        }
        if (sub === "voices") {
          if (!current.key) { await edit("请先配置 Azure API Key", false); return; }
          const target = endpoint(current, "voices/list");
          const value = await context.http.withResponse(target.url, {credentials: "omit", headers: {"Ocp-Apim-Subscription-Key": current.key}},
            (response, signal) => boundedJson(response, signal), {timeoutMs: 30_000, redirects: {allowedHosts: [target.host], maxRedirects: 0}});
          if (!Array.isArray(value)) throw new Error("Invalid voices");
          const filter = (invocation.args[1] ?? "zh-CN").toLowerCase();
          const voices = value.filter((item): item is Voice => item && typeof item === "object" && typeof item.ShortName === "string" && typeof item.LocalName === "string" && typeof item.Locale === "string" && typeof item.Gender === "string")
            .filter(item => filter === "all" || item.Locale.toLowerCase().includes(filter) || item.ShortName.toLowerCase().includes(filter)).slice(0, 500);
          if (!voices.length) { await edit(`未找到匹配「${escape(filter)}」的音色`); return; }
          const lines = voices.map(item => `${item.Gender === "Female" ? "👩" : item.Gender === "Male" ? "👨" : "👤"} <code>${escape(item.ShortName)}</code> (${escape(item.LocalName)})`);
          const body = `<b>可用音色列表</b> (${escape(filter)})\n\n${lines.join("\n")}`;
          if (body.length <= 4000) { await edit(body); return; }
          const raw = invocation.message.raw as ApiTypes.Message | undefined; if (!raw?.peerId) throw new Error("Missing peer");
          const {Api} = await import("teleproto");
          await context.telegram.withClient(client => client.sendFile(raw.peerId, {file: Buffer.from(lines.map(line => line.replace(/<[^>]+>/g, "")).join("\n")), attributes: [new Api.DocumentAttributeFilename({fileName: `voices_${filter.replace(/[^a-z0-9-]/g, "_")}.txt`})], caption: `可用音色：${voices.length} 个`}));
          await deleteCommand(invocation, context); return;
        }
        let input = invocation.args.join(" ").trim();
        if (!input && invocation.message.replyToId !== undefined) input = (await context.telegram.getReply(invocation.message))?.text ?? "";
        if (!input) { await edit(help(invocation.prefix)); return; }
        if (!current.key) { await edit(`请先在收藏夹中使用 <code>${escape(invocation.prefix)}tts config &lt;key&gt; &lt;region&gt;</code>`); return; }
        input = clean(input); if (!input) { await edit("文本为空或仅包含特殊字符", false); return; }
        let content = ssmlEscape(input);
        if (current.rate !== "1.0") content = `<prosody rate="${ssmlEscape(current.rate)}">${content}</prosody>`;
        if (current.style) content = `<mstts:express-as style="${ssmlEscape(current.style)}">${content}</mstts:express-as>`;
        const ssml = `<speak version='1.0' xml:lang='en-US' xmlns:mstts='https://www.w3.org/2001/mstts'><voice name='${ssmlEscape(current.voice)}'>${content}</voice></speak>`;
        const target = endpoint(current, "v1");
        await context.files.withTemp(async (directory, signal) => {
          const output = path.join(directory, current.format.startsWith("riff-") ? "speech.wav" : "speech.mp3");
          await context.http.withResponse(target.url, {method: "POST", credentials: "omit", headers: {"Ocp-Apim-Subscription-Key": current.key, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": current.format, "User-Agent": "MiBot-TTS"}, body: ssml},
            (response, requestSignal) => streamAudio(response, output, requestSignal), {timeoutMs: 120_000, redirects: {allowedHosts: [target.host], maxRedirects: 0}});
          signal.throwIfAborted(); const info = await stat(output); if (!info.isFile() || !info.size) throw new Error("Empty audio");
          const raw = invocation.message.raw as ApiTypes.Message | undefined; if (!raw?.peerId) throw new Error("Missing peer");
          const {Api} = await import("teleproto");
          await context.telegram.withClient(client => client.sendFile(raw.peerId, {file: output, voiceNote: true, replyTo: invocation.message.replyToId ?? invocation.message.id, attributes: [new Api.DocumentAttributeAudio({duration: 0, voice: true, title: "TTS Audio", performer: "Azure TTS"})]}));
        });
        await deleteCommand(invocation, context);
      } catch {
        if (context.signal.aborted) return;
        context.log.error("tts_failed"); await edit("Azure TTS 操作失败，请检查区域、密钥、音色和网络", false);
      }
    }}},
    settings: context => ({id: "tts", title: "TTS 语音合成", description: "Microsoft Azure Speech 配置", category: "插件配置", icon: "🗣️",
      getSchema: () => [{key: "key", label: "Azure Speech Key", type: "password", secret: true}, {key: "region", label: "Region", type: "select", options: [...REGIONS].sort().map(value => ({value, label: value}))}, {key: "voice", label: "语音角色", type: "string"}, {key: "style", label: "语音风格", type: "string"}, {key: "rate", label: "语速", type: "string"}, {key: "format", label: "输出格式", type: "select", options: [...FORMATS].map(value => ({value, label: value}))}],
      async getValues() { return config(context); },
      async setValues(patch) { await store(context).update(value => normalize({...value, ...patch, key: typeof patch.key === "string" ? patch.key : value.key}), context.signal); }}),
  });
}
