import {randomUUID} from "node:crypto";
import type {PluginContext} from "telebox/sdk";
import {providerOrder, type ProviderName, type SayConfig} from "./config";

export type SynthResult = {buffer: Buffer; extension: "wav" | "ogg" | "mp3"; provider: ProviderName};
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 24 * 1024 * 1024;

async function bytes(response: Response, signal: AbortSignal, maximum: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error("服务返回失败");
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximum) throw new Error("服务响应过大");
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength; if (total > maximum) throw new Error("服务响应过大");
      chunks.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!total) throw new Error("服务响应为空");
  return Buffer.concat(chunks, total);
}

function decoded(value: unknown): Buffer {
  if (typeof value !== "string" || !value || value.length > Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error("音频数据无效");
  }
  const result = Buffer.from(value, "base64");
  if (!result.length || result.length > MAX_AUDIO_BYTES) throw new Error("音频数据无效或过大");
  return result;
}

function json(buffer: Buffer): any {
  try { return JSON.parse(buffer.toString("utf8")); }
  catch { throw new Error("服务返回无效 JSON"); }
}

async function mimo(ctx: PluginContext, value: string, config: SayConfig): Promise<Omit<SynthResult, "provider">> {
  const current = config.providers.mimo;
  const host = current.endpoint === "tokenplan" ? "token-plan-cn.xiaomimimo.com" : "api.xiaomimimo.com";
  const messages: Array<{role: string; content: string}> = [];
  if (config.style.trim()) messages.push({role: "user", content: config.style.trim()});
  messages.push({role: "assistant", content: value});
  const data = await ctx.http.withResponse(`https://${host}/v1/chat/completions`, {method: "POST", credentials: "omit",
    headers: {"api-key": current.apiKey, Authorization: `Bearer ${current.apiKey}`, "Content-Type": "application/json", "User-Agent": "TeleBox-Say/2"},
    body: JSON.stringify({model: "mimo-v2.5-tts", messages, audio: {format: "wav", voice: current.voice || "mimo_default"}})},
  async (response, signal) => json(await bytes(response, signal, MAX_TEXT_BYTES)),
  {timeoutMs: 10_000, redirects: {allowedHosts: [host], maxRedirects: 0}});
  return {buffer: decoded(data?.choices?.[0]?.message?.audio?.data), extension: "wav"};
}

export function parseVolcChunks(raw: string): any[] {
  const value = raw.trim(); if (!value) return [];
  try { return [JSON.parse(value)]; } catch { /* NDJSON or concatenated objects */ }
  const lines = value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const parsed: any[] = [];
  if (lines.every(line => { try { parsed.push(JSON.parse(line)); return true; } catch { return false; } })) return parsed;
  return value.replace(/\}\s*\{/gu, "}\u0000{").split("\u0000").flatMap(piece => {
    try { return [JSON.parse(piece)]; } catch { return []; }
  });
}

async function volc(ctx: PluginContext, value: string, config: SayConfig): Promise<Omit<SynthResult, "provider">> {
  const current = config.providers.volc; const host = "openspeech.bytedance.com";
  const body = await ctx.http.withResponse(`https://${host}/api/v3/tts/unidirectional`, {method: "POST", credentials: "omit",
    headers: {"X-Api-Key": current.apiKey, "X-Api-Resource-Id": current.resourceId || "seed-tts-2.0",
      "X-Api-Request-Id": randomUUID(), "Content-Type": "application/json", "User-Agent": "TeleBox-Say/2"},
    body: JSON.stringify({req_params: {text: value, speaker: current.voice || "", audio_params: {format: "ogg_opus",
      sample_rate: 48_000, speech_rate: Math.round((config.speed - 1) * 100)}}})},
  (response, signal) => bytes(response, signal, MAX_TEXT_BYTES),
  {timeoutMs: 10_000, redirects: {allowedHosts: [host], maxRedirects: 0}});
  const chunks = parseVolcChunks(body.toString("utf8"));
  if (!chunks.length) throw new Error("火山未返回可解析数据");
  for (const chunk of chunks) if (typeof chunk?.code === "number" && chunk.code !== 0 && chunk.code !== 20_000_000) {
    throw new Error(`火山返回错误码 ${chunk.code}`);
  }
  const output = Buffer.concat(chunks.flatMap(chunk => typeof chunk?.data === "string" ? [decoded(chunk.data)] : []));
  if (!output.length || output.length > MAX_AUDIO_BYTES) throw new Error("火山未返回有效音频");
  return {buffer: output, extension: "ogg"};
}

async function fish(ctx: PluginContext, value: string, config: SayConfig): Promise<Omit<SynthResult, "provider">> {
  const current = config.providers.fish; const host = "api.fish.audio";
  const output = await ctx.http.withResponse(`https://${host}/v1/tts`, {method: "POST", credentials: "omit",
    headers: {Authorization: `Bearer ${current.apiKey}`, "Content-Type": "application/json", "User-Agent": "TeleBox-Say/2"},
    body: JSON.stringify({text: value, reference_id: current.voice})},
  (response, signal) => bytes(response, signal, MAX_AUDIO_BYTES),
  {timeoutMs: 10_000, redirects: {allowedHosts: [host], maxRedirects: 0}});
  return {buffer: output, extension: "mp3"};
}

export async function synthesize(ctx: PluginContext, value: string, config: SayConfig,
  progress?: (provider: ProviderName, attempt: number) => Promise<void>): Promise<SynthResult> {
  const order = providerOrder(config);
  if (!order.length) throw new Error("未配置任何语音服务商");
  for (let index = 0; index < order.length; index++) {
    const provider = order[index]!; await progress?.(provider, index + 1);
    try {
      const result = provider === "mimo" ? await mimo(ctx, value, config) : provider === "volc" ? await volc(ctx, value, config) : await fish(ctx, value, config);
      return {...result, provider};
    } catch {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      ctx.log.error("say_provider_failed", {provider});
    }
  }
  throw new Error("所有已配置语音服务商均失败");
}
