import {BlockList, isIP} from "node:net";
import {open, type FileHandle} from "node:fs/promises";
import path from "node:path";
import type {PluginContext} from "telebox/sdk";
import {
  autoSourceOrder, normalizeSearchResults, type ApiSong, type MusicHubConfig,
  type SearchSession, type SongUrlInfo, type SourceKey, type SourceMode,
} from "./catalog";

const API = new URL("https://music-api.gdstudio.xyz/api.php");
const SEARCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_API_BYTES = 512 * 1024;

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const {bytesWritten} = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("音频文件写入失败");
    offset += bytesWritten;
  }
}

type DownloadResult =
  | {ok: true; file: string; size: number; extension: string}
  | {ok: false; reason: string};

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32],
] as const) blocked.addSubnet(network, prefix, "ipv6");

function sanitizeFilename(value: string): string {
  return (value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim() || "music").slice(0, 80);
}

function extension(url: URL, contentType: string): string {
  const type = contentType.toLowerCase();
  if (type.includes("flac")) return "flac";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("wav")) return "wav";
  if (type.includes("mp4") || type.includes("m4a")) return "m4a";
  if (type.includes("aac")) return "aac";
  const suffix = url.pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1];
  return suffix && ["mp3", "flac", "m4a", "aac", "ogg", "wav"].includes(suffix) ? suffix : "mp3";
}

function hasAudioSignature(value: Uint8Array): boolean {
  const ascii = (start: number, text: string) => text.split("").every((character, offset) => value[start + offset] === character.charCodeAt(0));
  return ascii(0, "ID3") || ascii(0, "fLaC") || ascii(0, "OggS") ||
    (ascii(0, "RIFF") && ascii(8, "WAVE")) || ascii(4, "ftyp") ||
    (value.length >= 2 && value[0] === 0xff && (value[1]! & 0xe0) === 0xe0);
}

function safeDownloadUrl(value: unknown): URL {
  const url = new URL(String(value ?? ""));
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("播放链接不是安全的 HTTPS 地址");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("播放链接主机不可用");
  const literal = host.replace(/^\[|\]$/g, "");
  const family = isIP(literal);
  if (family && blocked.check(literal, family === 4 ? "ipv4" : "ipv6")) throw new Error("播放链接主机不可用");
  return url;
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.status < 200 || response.status >= 300) return {error: `HTTP ${response.status}`};
  if (!response.body) return {error: "API 返回空响应"};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_API_BYTES) return {error: "API 返回内容过大"};
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")); }
  catch { return {error: "API 返回格式无效"}; }
}

async function api(context: PluginContext, params: Readonly<Record<string, string | number>>, timeoutMs = SEARCH_TIMEOUT_MS): Promise<unknown> {
  const url = new URL(API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const value = await context.http.withResponse(url, {
    method: "GET", redirect: "manual", credentials: "omit",
    headers: {Accept: "application/json", "User-Agent": "TeleBox-MusicHub/2.0"},
  }, responseJson, {signal: context.signal, timeoutMs, denyPrivateAddresses: true, redirects: {allowedHosts: [API.hostname], maxRedirects: 2}});
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.error) throw new Error(String(record.error).slice(0, 300));
    if (record.message && Number(record.code) >= 400) throw new Error(String(record.message).slice(0, 300));
  }
  return value;
}

export async function searchSource(context: PluginContext, source: SourceKey, keyword: string, count: number): Promise<ApiSong[]> {
  return normalizeSearchResults(await api(context, {
    types: "search", source, name: keyword, count, pages: 1,
  }), source, count);
}

export async function searchMusic(context: PluginContext, config: MusicHubConfig, sourceMode: SourceMode, keyword: string): Promise<SearchSession> {
  const errors: string[] = [];
  for (const source of sourceMode === "auto" ? autoSourceOrder() : [sourceMode]) {
    context.signal.throwIfAborted();
    try {
      const results = await searchSource(context, source, keyword, config.maxResults);
      if (results.length) return {query: keyword, requestedSource: sourceMode, resolvedSource: source, results, page: 1, createdAt: Date.now()};
      errors.push(`${source}: 无结果`);
    } catch (error) {
      context.signal.throwIfAborted();
      errors.push(`${source}: ${error instanceof Error ? error.message : "请求失败"}`);
    }
  }
  throw new Error(errors.slice(0, 5).join("；") || "没有搜索结果");
}

export async function songUrl(context: PluginContext, song: ApiSong, bitrate: string): Promise<SongUrlInfo> {
  const value = await api(context, {types: "url", source: song.source, id: song.urlId, br: bitrate});
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const nested = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Record<string, unknown> : {};
  const url = safeDownloadUrl(record.url ?? nested.url);
  const size = Number(record.size ?? nested.size);
  const br = Number(record.br ?? nested.br);
  return {url, ...(Number.isFinite(size) && size > 0 ? {size} : {}), ...(Number.isFinite(br) && br > 0 ? {br} : {})};
}

export async function downloadSong(
  context: PluginContext, song: ApiSong, info: SongUrlInfo, config: MusicHubConfig, directory: string,
): Promise<DownloadResult> {
  if (info.size && info.size > config.maxUploadBytes) return {ok: false, reason: "文件超过上传大小限制"};
  const host = info.url.hostname;
  return context.http.withResponse(info.url, {
    method: "GET", redirect: "manual", credentials: "omit",
    headers: {Accept: "audio/*,application/octet-stream", "User-Agent": "TeleBox-MusicHub/2.0"},
  }, async (response, signal): Promise<DownloadResult> => {
    if (response.status < 200 || response.status >= 300 || !response.body) return {ok: false, reason: `音频下载失败（HTTP ${response.status}）`};
    const mime = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (!mime || !(mime.startsWith("audio/") || mime === "application/octet-stream" || mime === "video/mp4" || mime === "application/ogg")) {
      return {ok: false, reason: "下载内容不是支持的音频格式"};
    }
    const announced = Number(response.headers.get("content-length"));
    if (Number.isFinite(announced) && announced > config.maxUploadBytes) return {ok: false, reason: "文件超过上传大小限制"};
    const suffix = extension(info.url, mime);
    const file = path.join(directory, `${sanitizeFilename(`${song.name}-${song.artist.join("-")}`)}.${suffix}`);
    const handle = await open(file, "wx", 0o600);
    const reader = response.body.getReader();
    let total = 0;
    let oversized = false;
    let unsupported = false;
    const sniff = mime === "application/octet-stream";
    let signatureChecked = !sniff;
    const pending: Uint8Array[] = [];
    let pendingBytes = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > config.maxUploadBytes) {oversized = true; break;}
        if (signatureChecked) await writeAll(handle, chunk.value);
        else {
          pending.push(chunk.value); pendingBytes += chunk.value.byteLength;
          if (pendingBytes >= 12) {
            if (!hasAudioSignature(Buffer.concat(pending, pendingBytes).subarray(0, 12))) {unsupported = true; break;}
            signatureChecked = true;
            for (const value of pending) await writeAll(handle, value);
            pending.length = 0;
          }
        }
      }
      if (!signatureChecked && !oversized && !unsupported) {
        if (!hasAudioSignature(Buffer.concat(pending, pendingBytes).subarray(0, 12))) unsupported = true;
        else for (const value of pending) await writeAll(handle, value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await handle.close();
    }
    if (oversized) return {ok: false, reason: "文件超过上传大小限制"};
    if (unsupported) return {ok: false, reason: "下载内容不是支持的音频格式"};
    if (!total) return {ok: false, reason: "下载到的音频为空"};
    return {ok: true, file, size: total, extension: suffix};
  }, {signal: context.signal, timeoutMs: DOWNLOAD_TIMEOUT_MS, denyPrivateAddresses: true, redirects: {allowedHosts: [host], maxRedirects: 3}});
}
