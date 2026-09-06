import {join} from "node:path";
import {readFile, stat} from "node:fs/promises";
import type {MessageEnvelope, PluginContext} from "telebox/sdk";
import {type Config, requireInput} from "./config";
import {
  assertAllowedModel, CODEX_USER_AGENT, normalizeOpenAIBaseUrl, parseChatText,
  ProviderError, readBody, resolveProviderType, type ProviderConfig,
} from "./provider";
import {escape} from "./text";

export interface MediaInput {data: Buffer; mimeType: string}
interface MediaResult {data?: Buffer; url?: string; mimeType: string}

function endpoint(base: string, relative: string): string {
  return new URL(relative, base.endsWith("/") ? base : `${base}/`).toString();
}

function geminiBase(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = "/v1beta"; parsed.search = ""; parsed.hash = "";
  return parsed.toString();
}

function auth(provider: ProviderConfig, url: string, headers: Record<string, string>): {url: string; headers: Record<string, string>} {
  const type = resolveProviderType(provider);
  if (type === "gemini" || type === "local-cliproxy") {
    const parsed = new URL(url); if (!parsed.searchParams.has("key")) parsed.searchParams.set("key", provider.key);
    return {url: parsed.toString(), headers};
  }
  return {url, headers: {...headers, Authorization: `Bearer ${provider.key}`}};
}

async function json(ctx: PluginContext, provider: ProviderConfig, url: string, body: unknown, signal: AbortSignal, timeout: number): Promise<any> {
  const request = auth(provider, url, {"Content-Type": "application/json", "User-Agent": CODEX_USER_AGENT});
  const result = await ctx.http.withResponse(request.url, {method: "POST", headers: request.headers, body: JSON.stringify(body)}, async (response, active) => {
    if (!response.ok) return {error: new ProviderError("HTTP_STATUS", response.status)};
    try { return {text: await readBody(response, active, 32 * 1024 * 1024)}; }
    catch (error) { return {error: error instanceof ProviderError ? error : new ProviderError("FAILED")}; }
  }, {signal, timeoutMs: timeout * 1000});
  if (result.error) throw result.error;
  try { return JSON.parse(result.text!); } catch { throw new ProviderError("INVALID_RESPONSE"); }
}

async function raw(ctx: PluginContext, provider: ProviderConfig, url: string, body: unknown, signal: AbortSignal, timeout: number): Promise<string> {
  const request = auth(provider, url, {"Content-Type": "application/json", "User-Agent": CODEX_USER_AGENT});
  const result = await ctx.http.withResponse(request.url, {method: "POST", headers: request.headers, body: JSON.stringify(body)}, async (response, active) => {
    if (!response.ok) return {error: new ProviderError("HTTP_STATUS", response.status)};
    try { return {text: await readBody(response, active, 8 * 1024 * 1024)}; }
    catch (error) { return {error: error instanceof ProviderError ? error : new ProviderError("FAILED")}; }
  }, {signal, timeoutMs: timeout * 1000});
  if (result.error) throw result.error;
  return result.text!;
}

function selected(cfg: Config, mode: "Image" | "Video"): {provider: ProviderConfig; model: string} {
  const tag = cfg[`current${mode}Tag`]; const model = cfg[`current${mode}Model`];
  const provider = cfg.configs[tag];
  requireInput(tag && model && provider, `请先配置 ${mode.toLowerCase()} 模型`);
  assertAllowedModel(model);
  return {provider, model};
}

function imageResults(payload: any): MediaResult[] {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.images) ? payload.images : [];
  const result = rows.flatMap((item: any) => {
    const encoded = item?.b64_json ?? item?.b64Json ?? item?.base64;
    if (typeof encoded === "string" && encoded) return [{data: Buffer.from(encoded, "base64"), mimeType: item.mime_type ?? item.mimeType ?? "image/png"}];
    if (typeof item?.url === "string" && /^https?:\/\//i.test(item.url)) return [{url: item.url, mimeType: item.mime_type ?? item.mimeType ?? "image/png"}];
    return [];
  });
  if (!result.length) throw new ProviderError("EMPTY_OUTPUT");
  return result;
}

export async function messageMedia(ctx: PluginContext, message?: MessageEnvelope): Promise<MediaInput | undefined> {
  const rawMessage: any = message?.raw;
  if (!rawMessage?.media) return undefined;
  return ctx.files.withTemp(async (directory, signal) => {
    const output = join(directory, "input-media");
    const result = await ctx.telegram.withClient(async (client, active) => {
      const combined = AbortSignal.any([signal, active]); combined.throwIfAborted();
      const value = await client.downloadMedia(rawMessage, {outputFile: output}); combined.throwIfAborted(); return value;
    });
    if (!Buffer.isBuffer(result) && (await stat(output)).size > 20 * 1024 * 1024) throw new ProviderError("INPUT");
    const data = Buffer.isBuffer(result) ? result : await readFile(output, {signal});
    if (!data.length || data.length > 20 * 1024 * 1024) throw new ProviderError("INPUT");
    return {data, mimeType: rawMessage.media.document?.mimeType || "image/jpeg"};
  });
}

export async function generateImages(ctx: PluginContext, cfg: Config, prompt: string, input: MediaInput | undefined, signal: AbortSignal): Promise<MediaResult[]> {
  const {provider, model} = selected(cfg, "Image");
  const type = resolveProviderType(provider);
  if (type === "gemini" || type === "local-cliproxy" && model.toLowerCase().includes("gemini")) {
    const base = geminiBase(provider.url);
    if (model.toLowerCase().includes("imagen") && !input) {
      const payload = await json(ctx, provider, endpoint(base, `models/${model}:predict`), {instances: [{prompt}],
        parameters: {sampleCount: 1, outputOptions: {mimeType: "image/png"}}}, signal, cfg.timeout);
      const result = (payload.predictions ?? []).flatMap((item: any) => item?.bytesBase64Encoded
        ? [{data: Buffer.from(item.bytesBase64Encoded, "base64"), mimeType: item.mimeType || "image/png"}] : []);
      if (!result.length) throw new ProviderError("EMPTY_OUTPUT");
      return result;
    }
    const parts: any[] = [{text: prompt}];
    if (input) parts.push({inlineData: {data: input.data.toString("base64"), mimeType: input.mimeType}});
    const payload = await json(ctx, provider, endpoint(base, `models/${model}:generateContent`), {contents: [{parts}]}, signal, cfg.timeout);
    const root = payload.response ?? payload.data ?? payload;
    const result = (root.candidates ?? []).flatMap((candidate: any) => candidate?.content?.parts ?? []).flatMap((part: any) => {
      const inline = part?.inlineData ?? part?.inline_data;
      return inline?.data ? [{data: Buffer.from(inline.data, "base64"), mimeType: inline.mimeType ?? inline.mime_type ?? "image/png"}] : [];
    });
    if (!result.length) throw new ProviderError("EMPTY_OUTPUT");
    return result;
  }
  const base = type === "doubao" ? new URL(provider.url).origin : normalizeOpenAIBaseUrl(provider.url);
  const relative = type === "doubao" ? "api/v3/images/generations" : input ? "images/edits" : "images/generations";
  const body: Record<string, unknown> = {model, prompt};
  if (type === "doubao") Object.assign(body, {size: "2K", response_format: "url", sequential_image_generation: "disabled", watermark: true});
  else {
    body.size = "auto";
    if (model.startsWith("gpt-image")) body.quality = "high";
    if (!model.startsWith("gpt-") && !model.includes("chatgpt-image")) body.response_format = "b64_json";
  }
  if (input) body[type === "doubao" ? "image" : "images"] = type === "doubao"
    ? `data:${input.mimeType};base64,${input.data.toString("base64")}`
    : [{image_url: `data:${input.mimeType};base64,${input.data.toString("base64")}`}];
  return imageResults(await json(ctx, provider, endpoint(base, relative), body, signal, cfg.timeout));
}

export async function generateVideos(ctx: PluginContext, cfg: Config, prompt: string, inputs: readonly MediaInput[], signal: AbortSignal): Promise<MediaResult[]> {
  const {provider, model} = selected(cfg, "Video");
  const type = resolveProviderType(provider);
  requireInput(type === "openai" || type === "openai-compatible" || type === "local-cliproxy", "当前提供商暂不支持 V2 视频生成");
  const content: any[] = [];
  if (prompt.trim()) content.push({type: "text", text: prompt.trim()});
  for (const input of inputs.slice(0, 4)) content.push({type: "image_url", image_url: {url: `data:${input.mimeType};base64,${input.data.toString("base64")}`}});
  const userContent = content.length === 1 && content[0].type === "text" ? content[0].text : content.length ? content : "Generate a video";
  const response = await raw(ctx, provider, endpoint(normalizeOpenAIBaseUrl(provider.url), "chat/completions"),
    {model, messages: [{role: "user", content: userContent}], stream: provider.stream}, signal, cfg.timeout);
  const text = parseChatText(response, "openai", {maxResponseBytes: 8 * 1024 * 1024});
  const url = text.match(/https?:\/\/[^\s"'<>]+?\.(?:mp4|webm)(?:\?[^\s"'<>]*)?/i)?.[0];
  if (!url) throw new ProviderError("INVALID_RESPONSE");
  return [{url, mimeType: /\.webm(?:\?|$)/i.test(url) ? "video/webm" : "video/mp4"}];
}

async function downloadBinary(ctx: PluginContext, item: MediaResult, signal: AbortSignal): Promise<{data: Buffer; mimeType: string}> {
  if (item.data?.length) return {data: item.data, mimeType: item.mimeType};
  if (!item.url) throw new ProviderError("INVALID_RESPONSE");
  return ctx.http.withResponse(item.url, {redirect: "follow"}, async (response, active) => {
    if (!response.ok) throw new ProviderError("HTTP_STATUS", response.status);
    if (!response.body) throw new ProviderError("INVALID_RESPONSE");
    const declared = response.headers.get("content-type")?.split(";")[0].toLowerCase();
    if (declared?.startsWith("text/") || declared === "application/json") throw new ProviderError("INVALID_RESPONSE");
    const reader = response.body.getReader(); const chunks: Buffer[] = []; let total = 0, done = false;
    try {
      while (true) { active.throwIfAborted(); const chunk = await reader.read(); active.throwIfAborted();
        if (chunk.done) {done = true; break;} total += chunk.value.byteLength;
        if (total > 64 * 1024 * 1024) throw new ProviderError("RESPONSE_TOO_LARGE"); chunks.push(Buffer.from(chunk.value)); }
    } finally {try {if (!done) await reader.cancel();} finally {reader.releaseLock();}}
    if (!total) throw new ProviderError("EMPTY_OUTPUT");
    return {data: Buffer.concat(chunks, total), mimeType: declared || item.mimeType};
  }, {signal, timeoutMs: 120_000});
}

export async function sendMedia(ctx: PluginContext, message: MessageEnvelope, items: readonly MediaResult[], prompt: string,
  preview: boolean, tag: string, kind: "image" | "video", replyTo?: number): Promise<void> {
  requireInput(items.length > 0, "AI 未返回媒体");
  await ctx.telegram.withClient(async (client, signal) => {
    const {CustomFile} = await import("teleproto/client/uploads.js");
    const peer = (message.raw as any)?.peerId ?? message.chatId;
    for (const [index, source] of items.slice(0, 4).entries()) {
      signal.throwIfAborted();
      const item = await downloadBinary(ctx, source, signal);
      const extension = item.mimeType.includes("webm") ? "webm" : item.mimeType.includes("jpeg") ? "jpg" : item.mimeType.includes("png") ? "png" : kind === "video" ? "mp4" : "webp";
      const caption = `${escape(Array.from(prompt).slice(0, 140).join(""))}\n<i>🍀Powered by ${escape(tag)}</i>`;
      await client.sendFile(peer, {file: new CustomFile(`ai_${kind}_${Date.now()}_${index}.${extension}`, item.data.length, "", item.data),
        forceDocument: !preview, caption, parseMode: "html", ...(replyTo ? {replyTo} : {})});
    }
    try {await client.deleteMessages(peer, [message.id], {revoke: true});}
    catch {ctx.log.error("ai:command-delete-failed");}
  });
}
