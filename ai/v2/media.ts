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
export interface MediaResult {data?: Buffer; url?: string; mimeType: string; revisedPrompt?: string}

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

type CodexResult = {image?: string; revisedPrompt?: string; status?: string; id?: string};
function visitCodex(value: unknown, result: CodexResult): void {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (typeof item.partial_image_b64 === "string") result.image = item.partial_image_b64;
  if (typeof item.revised_prompt === "string") result.revisedPrompt = item.revised_prompt;
  if (typeof item.status === "string") result.status = item.status;
  if (typeof item.id === "string" && item.id.startsWith("resp_")) result.id = item.id;
  for (const child of Array.isArray(value) ? value : Object.values(item)) visitCodex(child, result);
}
async function codexStream(response: Response, signal: AbortSignal): Promise<CodexResult> {
  if (!response.ok) throw new ProviderError("HTTP_STATUS", response.status);
  if (!response.body) throw new ProviderError("INVALID_RESPONSE");
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let pending = "", total = 0, done = false; const result: CodexResult = {};
  const consume = (block: string): void => {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim(); if (!data || data === "[DONE]") continue;
      try { visitCodex(JSON.parse(data), result); } catch { /* ignore malformed progress frames */ }
    }
  };
  try {
    for (;;) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) {done = true; break;}
      total += part.value.byteLength; if (total > 48 * 1024 * 1024) throw new ProviderError("RESPONSE_TOO_LARGE");
      pending += decoder.decode(part.value, {stream: true});
      let boundary = /\r?\n\r?\n/.exec(pending);
      while (boundary?.index !== undefined) {
        consume(pending.slice(0, boundary.index)); pending = pending.slice(boundary.index + boundary[0].length);
        boundary = /\r?\n\r?\n/.exec(pending);
      }
    }
    pending += decoder.decode(); if (pending.trim()) consume(pending);
    return result;
  } finally { try {if (!done) await reader.cancel();} finally {reader.releaseLock();} }
}
const delay = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) {reject(signal.reason); return;}
  const timer = setTimeout(done, ms);
  function done(): void { signal.removeEventListener("abort", abort); resolve(); }
  function abort(): void { clearTimeout(timer); reject(signal.reason); }
  signal.addEventListener("abort", abort, {once: true});
});
function codexEndpoint(value: string): string {
  const url = new URL(value);
  if (url.pathname === "/" || !url.pathname) url.pathname = "/backend-api/codex/responses";
  url.search = ""; url.hash = ""; return url.toString();
}
async function codexImages(ctx: PluginContext, cfg: Config, provider: ProviderConfig, model: string, prompt: string,
  input: MediaInput | undefined, signal: AbortSignal): Promise<MediaResult[]> {
  const endpointUrl = codexEndpoint(provider.url);
  const content = input ? [{type: "input_text", text: prompt},
    {type: "input_image", image_url: `data:${input.mimeType};base64,${input.data.toString("base64")}`}] : prompt;
  const body = {model, instructions: "Generate the requested image.", input: [{role: "user", content}], store: false,
    tools: [{type: "image_generation"}], reasoning: {effort: "low"}, stream: true};
  const headers = {Authorization: `Bearer ${provider.key}`, "Content-Type": "application/json"};
  let result = await ctx.http.withResponse(endpointUrl, {method: "POST", redirect: "manual", credentials: "omit", headers,
    body: JSON.stringify(body)}, codexStream, {timeoutMs: cfg.timeout * 1000, signal, redirects: {allowedHosts: [new URL(endpointUrl).hostname], maxRedirects: 0}});
  const deadline = Date.now() + cfg.timeout * 1000;
  while (!result.image && result.id && result.status === "in_progress" && Date.now() < deadline) {
    await delay(Math.min(20_000, Math.max(1, deadline - Date.now())), signal);
    if (Date.now() >= deadline) break;
    const pollUrl = `${endpointUrl}/${encodeURIComponent(result.id)}`;
    const response = await ctx.http.withResponse(pollUrl, {method: "GET", redirect: "manual", credentials: "omit", headers},
      async (current, active) => {
        if (!current.ok) throw new ProviderError("HTTP_STATUS", current.status);
        return readBody(current, active, 48 * 1024 * 1024);
      }, {timeoutMs: Math.max(1000, Math.min(60_000, deadline - Date.now())), signal,
        redirects: {allowedHosts: [new URL(endpointUrl).hostname], maxRedirects: 0}});
    const next: CodexResult = {}; visitCodex(JSON.parse(response), next);
    result = {...result, ...next};
  }
  if (!result.image) throw new ProviderError(result.status === "in_progress" ? "TIMEOUT" : "EMPTY_OUTPUT");
  const data = Buffer.from(result.image, "base64");
  if (!data.length || data.length > 32 * 1024 * 1024) throw new ProviderError("RESPONSE_TOO_LARGE");
  return [{data, mimeType: "image/png", ...(result.revisedPrompt ? {revisedPrompt: result.revisedPrompt} : {})}];
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

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
let sharpFactory: any;
function getSharp(): any | undefined {
  if (sharpFactory !== undefined) return sharpFactory;
  try { sharpFactory = require("sharp"); } catch { sharpFactory = null; }
  return sharpFactory ?? undefined;
}

/** TL `document.size` is a long; compare with BigInt so >2^53 sizes are exact.
 * When a thumbnail is selected, bound by that thumbnail's declared size instead of
 * the whole document (a large video may carry a small thumb). */
function declaredBytes(raw: any, thumb?: any): bigint | undefined {
  const source = thumb !== undefined
    ? (thumb?.size ?? thumb?.sizes?.at?.(-1))
    : (raw?.media?.document?.size ?? raw?.media?.photo?.sizes?.at(-1)?.size);
  if (source === undefined || source === null) return undefined;
  try { return BigInt(String(source)); } catch { return undefined; }
}
function cumulativeBytes(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  try { return BigInt(String(value ?? 0)); } catch { return 0n; }
}

/** Single-frame PNG decode with a hard pixel budget; never an unbounded multi-frame decode. */
async function sharpFirstFrame(buffer: Buffer): Promise<Buffer | undefined> {
  const sharp = getSharp();
  if (!sharp) return undefined;
  try { return await sharp(buffer, {pages: 1, limitInputPixels: MAX_INPUT_PIXELS}).png().toBuffer(); } catch { return undefined; }
}

function checkDownloadProgress(value: unknown, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (cumulativeBytes(value) > BigInt(MAX_INPUT_BYTES)) throw new ProviderError("INPUT");
}

export async function messageMedia(ctx: PluginContext, message?: MessageEnvelope): Promise<MediaInput | undefined> {
  const rawMessage: any = message?.raw;
  if (!rawMessage?.media) return undefined;
  const declared = declaredBytes(rawMessage);
  if (declared !== undefined && declared > BigInt(MAX_INPUT_BYTES)) throw new ProviderError("INPUT");
  return ctx.files.withTemp(async (directory, signal) => {
    const output = join(directory, "input-media");
    const result = await ctx.telegram.withClient(async (client, active) => {
      const combined = AbortSignal.any([signal, active]); combined.throwIfAborted();
      const value = await client.downloadMedia(rawMessage, {outputFile: output, progressCallback: (downloaded: unknown) => checkDownloadProgress(downloaded, combined)});
      combined.throwIfAborted(); return value;
    });
    if (Buffer.isBuffer(result)) {
      if (!result.length || result.length > MAX_INPUT_BYTES) throw new ProviderError("INPUT");
      return {data: result, mimeType: rawMessage.media.document?.mimeType || "image/jpeg"};
    }
    const info = await stat(output);
    if (info.size > MAX_INPUT_BYTES) throw new ProviderError("INPUT");
    const data = await readFile(output, {signal});
    if (!data.length || data.length > MAX_INPUT_BYTES) throw new ProviderError("INPUT");
    return {data, mimeType: rawMessage.media.document?.mimeType || "image/jpeg"};
  });
}

function isAnimatedDocument(doc: any): boolean {
  const mime = doc?.mimeType || "";
  return mime === "image/gif" || mime === "video/webm" || mime === "application/x-tgsticker" ||
    mime === "application/x-tg-sticker" || (doc?.attributes ?? []).some((attr: any) => attr?.className === "DocumentAttributeAnimated");
}

async function fetchMedia(ctx: PluginContext, raw: any, options: Record<string, unknown>, signal: AbortSignal): Promise<Buffer | undefined> {
  return ctx.files.withTemp(async (directory, tempSignal) => {
    const output = join(directory, `ai-part-${Math.random().toString(36).slice(2)}`);
    const declared = declaredBytes(raw, options.thumb);
    if (declared !== undefined && declared > BigInt(MAX_INPUT_BYTES)) return undefined;
    const value = await ctx.telegram.withClient(async (client, active) => {
      const combined = AbortSignal.any([signal, tempSignal, active]); combined.throwIfAborted();
      const downloaded = await client.downloadMedia(raw, {outputFile: output, ...options,
        progressCallback: (progress: unknown) => checkDownloadProgress(progress, combined)});
      combined.throwIfAborted(); return downloaded;
    });
    if (Buffer.isBuffer(value)) return value.length && value.length <= MAX_INPUT_BYTES ? value : undefined;
    // Check the on-disk size before reading; never read an oversized file into memory.
    const info = await stat(output);
    if (info.size > MAX_INPUT_BYTES) return undefined;
    const written = await readFile(output, {signal});
    return written.length && written.length <= MAX_INPUT_BYTES ? written : undefined;
  });
}

async function imagePartFromMessage(ctx: PluginContext, raw: any, signal: AbortSignal): Promise<MediaInput | undefined> {
  const media = raw?.media;
  if (!media) return undefined;
  if (media.className === "MessageMediaPhoto") {
    const buffer = await fetchMedia(ctx, raw, {}, signal);
    return buffer ? {data: buffer, mimeType: "image/jpeg"} : undefined;
  }
  if (media.className !== "MessageMediaDocument" || media.document?.className !== "Document") return undefined;
  const doc = media.document;
  const mime = doc.mimeType || "";
  if (!isAnimatedDocument(doc) && /^image\/(?:jpeg|png|gif|webp)$/i.test(mime)) {
    const buffer = await fetchMedia(ctx, raw, {}, signal);
    return buffer ? {data: buffer, mimeType: mime} : undefined;
  }
  // Animated content: the static thumb is the reliable reference. A raw GIF can
  // yield its first frame through sharp; video/TGS containers cannot be decoded by
  // sharp and are only usable through a thumb (no silent fake image).
  const thumb = (doc.thumbs ?? []).at(-1);
  if (thumb) {
    const buffer = await fetchMedia(ctx, raw, {thumb}, signal);
    if (buffer) {
      const png = await sharpFirstFrame(buffer);
      if (png) return {data: png, mimeType: "image/png"};
    }
  }
  if (/^image\/gif$/i.test(mime)) {
    const full = await fetchMedia(ctx, raw, {}, signal);
    if (full) {
      const png = await sharpFirstFrame(full);
      if (png) return {data: png, mimeType: "image/png"};
    }
  }
  return undefined;
}

export interface CollectedMedia { images: MediaInput[]; dropped: boolean }

/**
 * Collects reply/own image inputs. Albums keep original order (groupedId, iterMessages 50)
 * and every part shares the bounded managed download path. Parts beyond the total
 * byte budget are dropped explicitly instead of silently truncating history.
 */
export async function collectMessageImages(ctx: PluginContext, message: MessageEnvelope | undefined, signal: AbortSignal): Promise<CollectedMedia> {
  const raw: any = message?.raw;
  if (!raw?.media) return {images: [], dropped: false};
  const groupedId = raw.groupedId ? String(raw.groupedId) : undefined;
  const raws: any[] = [];
  let dropped = false;
  if (!groupedId) raws.push(raw);
  else {
    const peer = raw.chatId ?? raw.peerId;
    const group: any[] = [];
    await ctx.telegram.withClient(async (client: any, active: AbortSignal) => {
      const combined = AbortSignal.any([signal, active]);
      let index = 0;
      for await (const candidate of client.iterMessages(peer, {limit: 50})) {
        combined.throwIfAborted();
        if (++index > 50) break;
        if (candidate && candidate.groupedId && String(candidate.groupedId) === groupedId) group.push(candidate);
      }
    });
    group.sort((a, b) => Number(a.id) - Number(b.id));
    // Disclose (and do not download) album members beyond the 4-image cap.
    if (group.length > 4) dropped = true;
    for (const candidate of group.slice(0, 4)) raws.push(candidate);
  }
  const images: MediaInput[] = [];
  let total = 0;
  for (const candidate of raws) {
    signal.throwIfAborted();
    const part = await imagePartFromMessage(ctx, candidate, signal);
    if (!part) continue;
    if (total + part.data.byteLength > MAX_INPUT_BYTES || images.length >= 4) { dropped = true; continue; }
    total += part.data.byteLength;
    images.push(part);
  }
  return {images, dropped};
}

/**
 * Merges reply→own image sets under one budget (total ≤4 images, total ≤20MiB),
 * so the union cannot silently drop the 5th image when each side was under 4.
 */
export function mergeMessageImages(sets: readonly CollectedMedia[]): CollectedMedia {
  let dropped = sets.some(set => set.dropped);
  const images: MediaInput[] = [];
  let total = 0;
  for (const set of sets) {
    for (const image of set.images) {
      if (images.length >= 4 || total + image.data.byteLength > MAX_INPUT_BYTES) { dropped = true; continue; }
      total += image.data.byteLength;
      images.push(image);
    }
  }
  return {images, dropped};
}

export async function generateImages(ctx: PluginContext, cfg: Config, prompt: string, input: MediaInput | undefined, signal: AbortSignal): Promise<MediaResult[]> {
  const {provider, model} = selected(cfg, "Image");
  const type = resolveProviderType(provider);
  if (type === "codex") return codexImages(ctx, cfg, provider, model, prompt, input, signal);
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
    const payload = await json(ctx, provider, endpoint(base, `models/${model}:generateContent`),
      {contents: [{parts}], generationConfig: {responseModalities: ["TEXT", "IMAGE"]}}, signal, cfg.timeout);
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

async function getJson(ctx: PluginContext, provider: ProviderConfig, url: string, signal: AbortSignal, timeout: number): Promise<any> {
  const request = auth(provider, url, {"Content-Type": "application/json", "User-Agent": CODEX_USER_AGENT});
  const result = await ctx.http.withResponse(request.url, {method: "GET", headers: request.headers}, async (response, active) => {
    if (!response.ok) return {error: new ProviderError("HTTP_STATUS", response.status)};
    try { return {text: await readBody(response, active, 32 * 1024 * 1024)}; }
    catch (error) { return {error: error instanceof ProviderError ? error : new ProviderError("FAILED")}; }
  }, {signal, timeoutMs: timeout * 1000});
  if (result.error) throw result.error;
  try { return JSON.parse(result.text!); } catch { throw new ProviderError("INVALID_RESPONSE"); }
}

function geminiVideoApiUrl(baseUrl: string, model: string, key: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/v1beta/models/${model || "veo-2.0-generate-001"}:generateVideos`;
  url.searchParams.set("key", key);
  return url.toString();
}

function geminiOperationUrl(baseOrigin: string, name: string, key: string): string {
  const url = new URL(baseOrigin);
  const clean = name.replace(/^\/+/, "");
  url.pathname = `/${clean.startsWith("v1beta/") ? clean : `v1beta/${clean}`}`;
  url.searchParams.set("key", key);
  return url.toString();
}

function extractGeminiVideoResult(data: any): {uri?: string; bytes?: string} | null {
  const response = data?.response ?? data?.data?.response ?? data;
  const uri = response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
    response?.generate_video_response?.generated_samples?.[0]?.video?.uri;
  if (uri) return {uri};
  const bytes = response?.generatedVideos?.[0]?.video?.videoBytes ||
    response?.generated_videos?.[0]?.video?.video_bytes ||
    response?.generatedVideos?.[0]?.video?.video_bytes ||
    response?.generated_videos?.[0]?.video?.videoBytes;
  if (bytes) return {bytes};
  return null;
}

function geminiOperationError(data: any): string {
  const err = data?.error ?? data?.data?.error;
  if (!err) return "视频生成失败";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  if (typeof err.status === "string") return err.status;
  return "视频生成失败";
}

function doubaoVideoUrl(data: any): string | null {
  return data?.data?.result?.video_url || data?.data?.output?.video_url || data?.data?.video_url ||
    data?.video_url || data?.content?.video_url || data?.data?.content?.video_url || null;
}

function doubaoContent(prompt: string, inputs: readonly MediaInput[], mode: VideoImageMode): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  if (prompt.trim()) content.push({type: "text", text: prompt.trim()});
  inputs.slice(0, 4).forEach((input, index) => {
    const item: Record<string, unknown> = {type: "image_url", image_url: {url: `data:${input.mimeType};base64,${input.data.toString("base64")}`}};
    if (mode === "first") item.role = "first_frame";
    else if (mode === "firstlast") item.role = index === 0 ? "first_frame" : "last_frame";
    else if (mode === "reference") item.role = "reference_image";
    else if (inputs.length === 2) item.role = index === 0 ? "first_frame" : "last_frame";
    else if (inputs.length > 2) item.role = "reference_image";
    content.push(item);
  });
  return content;
}

async function poll<T>(fetchJob: (signal: AbortSignal) => Promise<any>,
  parse: (data: any) => {status: "pending" | "succeeded" | "failed"; result?: T; error?: string},
  signal: AbortSignal, attempts = 303, intervalMs = 2000): Promise<T> {
  for (let index = 0; index < attempts; index++) {
    signal.throwIfAborted();
    const data = await fetchJob(signal);
    signal.throwIfAborted();
    const result = parse(data);
    if (result.status === "failed") throw new ProviderError("PROVIDER");
    if (result.status === "succeeded") {
      if (result.result === undefined) throw new ProviderError("EMPTY_OUTPUT");
      return result.result;
    }
    await delay(intervalMs, signal);
  }
  throw new ProviderError("TIMEOUT");
}

export type VideoImageMode = "auto" | "reference" | "first" | "firstlast";

async function generateGeminiVideo(ctx: PluginContext, cfg: Config, provider: ProviderConfig, model: string,
  prompt: string, inputs: readonly MediaInput[], signal: AbortSignal): Promise<MediaResult[]> {
  const base = geminiBase(provider.url);
  const apiUrl = geminiVideoApiUrl(base, model, provider.key);
  const parts: Array<Record<string, unknown>> = [];
  if (prompt.trim()) parts.push({text: prompt.trim()});
  for (const input of inputs.slice(0, 4)) parts.push({inlineData: {data: input.data.toString("base64"), mimeType: input.mimeType}});
  const response = await json(ctx, provider, apiUrl, {contents: [{parts}],
    videoGenerationConfig: {numberOfVideos: 1, durationSeconds: cfg.videoDuration, enableAudio: cfg.videoAudio}}, signal, cfg.timeout);
  const direct = extractGeminiVideoResult(response);
  if (direct?.bytes) return [{data: Buffer.from(direct.bytes, "base64"), mimeType: "video/mp4"}];
  if (direct?.uri) return [{url: direct.uri, mimeType: "video/mp4"}];
  const operationName = response?.name;
  if (typeof operationName !== "string" || !operationName) throw new ProviderError("INVALID_RESPONSE");
  const baseOrigin = geminiBase(provider.url);
  const operation = await poll<any>(
    (active) => getJson(ctx, provider, geminiOperationUrl(baseOrigin, operationName, provider.key), active, cfg.timeout),
    (data) => data?.done === true ? (data?.error ? {status: "failed", error: geminiOperationError(data)} : {status: "succeeded", result: data}) : {status: "pending"},
    signal);
  const final = extractGeminiVideoResult(operation);
  if (final?.bytes) return [{data: Buffer.from(final.bytes, "base64"), mimeType: "video/mp4"}];
  if (final?.uri) return [{url: final.uri, mimeType: "video/mp4"}];
  throw new ProviderError("EMPTY_OUTPUT");
}

async function generateDoubaoVideo(ctx: PluginContext, cfg: Config, provider: ProviderConfig, model: string,
  prompt: string, inputs: readonly MediaInput[], mode: VideoImageMode, signal: AbortSignal): Promise<MediaResult[]> {
  const base = new URL(provider.url).origin;
  const endpointPath = "api/v3/contents/generations/tasks";
  const response = await json(ctx, provider, endpoint(base, endpointPath), {model, content: doubaoContent(prompt, inputs, mode),
    generateAudio: cfg.videoAudio, duration: cfg.videoDuration}, signal, cfg.timeout);
  const taskId = response?.task_id || response?.data?.task_id || response?.data?.id || response?.id;
  if (!taskId) throw new ProviderError("INVALID_RESPONSE");
  const url = await poll<string>(
    (active) => getJson(ctx, provider, endpoint(base, `${endpointPath}/${taskId}`), active, cfg.timeout),
    (data) => {
      if (data?.status === "failed" || data?.data?.status === "failed") return {status: "failed", error: "视频生成失败"};
      const video = doubaoVideoUrl(data);
      return video ? {status: "succeeded", result: video} : {status: "pending"};
    },
    signal);
  return [{url, mimeType: "video/mp4"}];
}

export async function generateVideos(ctx: PluginContext, cfg: Config, prompt: string, inputs: readonly MediaInput[], signal: AbortSignal, mode: VideoImageMode = "auto"): Promise<MediaResult[]> {
  const {provider, model} = selected(cfg, "Video");
  const type = resolveProviderType(provider);
  if (type === "gemini" || (type === "local-cliproxy" && model.toLowerCase().includes("veo"))) {
    return generateGeminiVideo(ctx, cfg, provider, model, prompt, inputs, signal);
  }
  if (type === "doubao") return generateDoubaoVideo(ctx, cfg, provider, model, prompt, inputs, mode, signal);
  requireInput(type === "openai" || type === "openai-compatible" || type === "local-cliproxy", "当前提供商暂不支持视频生成");
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

export async function materializeMedia(ctx: PluginContext, items: readonly MediaResult[], signal: AbortSignal): Promise<MediaResult[]> {
  const output: MediaResult[] = [];
  for (const item of items.slice(0, 4)) {
    signal.throwIfAborted();
    const value = await downloadBinary(ctx, item, signal);
    output.push({...item, data: value.data, mimeType: value.mimeType, url: undefined});
  }
  return output;
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
