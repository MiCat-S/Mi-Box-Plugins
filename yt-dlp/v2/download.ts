import {constants} from "node:fs";
import {access, lstat, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import type {MessageEnvelope, PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const YTDLP_PATHS = ["/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp", "/opt/homebrew/bin/yt-dlp"] as const;
const FFMPEG_PATHS = ["/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const MAX_PROCESS_OUTPUT = 512 * 1024;
const MAX_WORKSPACE_BYTES = 160 * 1024 * 1024;
const WORKSPACE_OVERHEAD_BYTES = 10 * 1024 * 1024;
const WORKSPACE_POLL_MS = 100;
const MAX_WORKSPACE_ENTRIES = 64;

export interface ToolPaths {ytDlp: string; ffmpeg: string}
export interface SongMetadata {title: string; artist: string; album?: string}
export interface DownloadDependencies {locateTools?: () => Promise<ToolPaths>}
export interface DownloadOptions {
  cookie: string;
  proxy: string;
  quality: string;
  maxDurationSeconds: number;
  maxUploadBytes: number;
}
export interface DownloadResult {title: string; artist: string; duration: number}

async function executable(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error("DEPENDENCY_MISSING");
}

export async function locateTools(): Promise<ToolPaths> {
  const [ytDlp, ffmpeg] = await Promise.all([executable(YTDLP_PATHS), executable(FFMPEG_PATHS)]);
  return {ytDlp, ffmpeg};
}

export function workspaceBudget(maxUploadBytes: number): number {
  return Math.min(MAX_WORKSPACE_BYTES, maxUploadBytes * 3 + WORKSPACE_OVERHEAD_BYTES);
}

function videoId(value: string): string | undefined {
  return /^[A-Za-z0-9_-]{6,20}$/.test(value) ? value : undefined;
}

function targetFor(input: string): string {
  const value = input.trim();
  if (!value || value.length > 300 || /[\u0000-\u001f]/.test(value)) throw new Error("INVALID_QUERY");
  if (!value.includes("://")) return `ytsearch1:${value}`;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) throw new Error("INVALID_URL");
  const host = url.hostname.toLowerCase();
  const id = host === "youtu.be" ? videoId(url.pathname.split("/").filter(Boolean)[0] ?? "")
    : url.pathname === "/watch" ? videoId(url.searchParams.get("v") ?? "")
    : url.pathname.startsWith("/shorts/") ? videoId(url.pathname.split("/")[2] ?? "") : undefined;
  if (!id) throw new Error("INVALID_URL");
  return `https://www.youtube.com/watch?v=${id}`;
}

function cookieText(input: string): string {
  const value = input.trim();
  if (!value) return "";
  if (value.includes("\t") && /(^|\n)# Netscape HTTP Cookie File/.test(value)) return value.endsWith("\n") ? value : `${value}\n`;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      const rows = parsed.flatMap(item => {
        if (!item || typeof item !== "object") return [];
        const cookie = item as Record<string, unknown>;
        const name = typeof cookie.name === "string" ? cookie.name : "";
        const content = typeof cookie.value === "string" ? cookie.value : "";
        const domain = typeof cookie.domain === "string" && cookie.domain ? cookie.domain : ".youtube.com";
        const cookiePath = typeof cookie.path === "string" && cookie.path ? cookie.path : "/";
        if (!name || /[\t\r\n]/.test(name + content + domain + cookiePath)) return [];
        const expires = Number(cookie.expirationDate ?? cookie.expires ?? 0);
        return [`${domain}\t${domain.startsWith(".") ? "TRUE" : "FALSE"}\t${cookiePath}\t${cookie.secure === false ? "FALSE" : "TRUE"}\t${Number.isFinite(expires) ? Math.max(0, Math.floor(expires)) : 0}\t${name}\t${content}`];
      });
      if (rows.length) return `# Netscape HTTP Cookie File\n${rows.join("\n")}\n`;
    }
  } catch {}
  const rows = value.split(/;\s*/).flatMap(pair => {
    const separator = pair.indexOf("=");
    if (separator < 1) return [];
    const name = pair.slice(0, separator).trim();
    const content = pair.slice(separator + 1).trim();
    return name && !/[\t\r\n]/.test(name + content)
      ? [`.youtube.com\tTRUE\t/\tTRUE\t0\t${name}\t${content}`] : [];
  });
  if (!rows.length) throw new Error("INVALID_COOKIE");
  return `# Netscape HTTP Cookie File\n${rows.join("\n")}\n`;
}

function proxyUrl(input: string): string {
  const url = new URL(input);
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) || !url.hostname) throw new Error("INVALID_PROXY");
  return url.toString();
}

function environment(tools: ToolPaths): NodeJS.ProcessEnv {
  return {PATH: [...new Set([path.dirname(tools.ytDlp), path.dirname(tools.ffmpeg), "/usr/local/bin", "/usr/bin", "/bin"])].join(":"), LC_ALL: "C.UTF-8"};
}

function parseInfo(stdout: Buffer, limits: DownloadOptions): DownloadResult {
  const line = stdout.toString("utf8").trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("NO_RESULT");
  const value = JSON.parse(line) as Record<string, unknown>;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const artist = typeof value.artist === "string" && value.artist.trim() ? value.artist.trim()
    : typeof value.uploader === "string" && value.uploader.trim() ? value.uploader.trim()
    : typeof value.channel === "string" && value.channel.trim() ? value.channel.trim() : "未知歌手";
  const duration = Number(value.duration);
  const requested = Array.isArray(value.requested_downloads) ? value.requested_downloads : [];
  const requestedBytes = requested.reduce((total, item) => {
    if (!item || typeof item !== "object") return total;
    const source = item as Record<string, unknown>;
    const size = Number(source.filesize ?? source.filesize_approx ?? 0);
    return Number.isFinite(size) && size > 0 ? total + size : total;
  }, 0);
  const sourceBytes = requestedBytes || Number(value.filesize ?? value.filesize_approx ?? 0);
  if (!title || !Number.isFinite(duration) || duration <= 0 || duration > limits.maxDurationSeconds || value.is_live === true) throw new Error("UNSUPPORTED_MEDIA");
  if (Number.isFinite(sourceBytes) && sourceBytes > limits.maxUploadBytes) throw new Error("MEDIA_TOO_LARGE");
  return {title, artist, duration: Math.floor(duration)};
}

function safeName(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  return Array.from(clean || "YouTube Music").slice(0, 100).join("");
}

async function optionalThumbnail(directory: string): Promise<string | undefined> {
  for (const name of await readdir(directory)) {
    if (!/^track\.(?:jpe?g|png|webp)$/i.test(name)) continue;
    const file = path.join(directory, name);
    const stats = await lstat(file);
    if (stats.isFile() && !stats.isSymbolicLink() && stats.size > 0 && stats.size <= 10 * 1024 * 1024) return file;
  }
}

async function directoryBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, {withFileTypes: true});
  if (entries.length > MAX_WORKSPACE_ENTRIES) throw new Error("WORKSPACE_LIMIT");
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      if (entry.isSymbolicLink()) throw new Error("INVALID_OUTPUT");
      continue;
    }
    try { total += (await lstat(path.join(directory, entry.name))).size; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  return total;
}

async function runMonitored(
  context: PluginContext,
  command: string,
  args: readonly string[],
  directory: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number,
  budget: number,
) {
  const limit = new AbortController();
  const active = AbortSignal.any([signal, limit.signal]);
  let settled = false, exceeded = false, monitorError: unknown;
  const monitor = (async () => {
    try {
      while (!settled) {
        signal.throwIfAborted();
        if (await directoryBytes(directory) > budget) { exceeded = true; limit.abort(); return; }
        await delay(WORKSPACE_POLL_MS, undefined, {signal});
      }
    } catch (error) { monitorError = error; limit.abort(); }
  })();
  let result: Awaited<ReturnType<PluginContext["processes"]["run"]>> | undefined;
  let processError: unknown;
  try {
    result = await context.processes.run(command, args, {cwd: directory, env, signal: active, timeoutMs, maxOutputBytes: MAX_PROCESS_OUTPUT});
  } catch (error) { processError = error; }
  finally { settled = true; }
  await monitor;
  signal.throwIfAborted();
  if (monitorError) throw monitorError;
  if (exceeded) throw new Error("WORKSPACE_LIMIT");
  if (processError) throw processError;
  return result!;
}

export async function downloadAndSend(
  context: PluginContext,
  message: MessageEnvelope,
  query: string,
  options: DownloadOptions,
  preferred: SongMetadata | undefined,
  signal: AbortSignal,
  dependencies: DownloadDependencies = {},
): Promise<DownloadResult> {
  signal.throwIfAborted();
  const tools = await (dependencies.locateTools ?? locateTools)();
  const target = targetFor(query);
  const env = environment(tools);
  return context.files.withTemp(async (directory, temporarySignal) => {
    const active = AbortSignal.any([signal, temporarySignal]);
    active.throwIfAborted();
    const configuration: string[] = [];
    if (options.cookie) {
      const cookieFile = path.join(directory, "cookies.txt");
      await writeFile(cookieFile, cookieText(options.cookie), {encoding: "utf8", mode: 0o600, signal: active});
      configuration.push("--cookies", cookieFile);
    }
    if (options.proxy) {
      const proxyFile = path.join(directory, "yt-dlp.conf");
      await writeFile(proxyFile, `--proxy ${JSON.stringify(proxyUrl(options.proxy))}\n`, {encoding: "utf8", mode: 0o600, signal: active});
      configuration.push("--config-locations", proxyFile);
    }
    const common = ["--ignore-config", "--no-cache-dir", "--no-playlist", "--no-warnings", "--quiet", ...configuration];
    const budget = workspaceBudget(options.maxUploadBytes);
    const inspected = await runMonitored(context, tools.ytDlp,
      [...common, "--dump-single-json", "--skip-download", target], directory, env, active, 60_000, budget);
    const info = parseInfo(inspected.stdout, options);
    active.throwIfAborted();
    await runMonitored(context, tools.ytDlp, [
      ...common,
      "--match-filter", `duration <= ${options.maxDurationSeconds} & !is_live`,
      "--max-filesize", String(options.maxUploadBytes),
      "--format", "bestaudio/best",
      "--ffmpeg-location", path.dirname(tools.ffmpeg),
      "-x", "--audio-format", "mp3", "--audio-quality", options.quality || "0",
      "--embed-metadata", "--write-thumbnail", "--convert-thumbnails", "jpg", "--embed-thumbnail",
      "-P", directory, "-o", "track.%(ext)s", "--print", "after_move:filepath", target,
    ], directory, env, active, 180_000, budget);
    if (await directoryBytes(directory) > budget) throw new Error("WORKSPACE_LIMIT");
    const audio = path.join(directory, "track.mp3");
    const stats = await lstat(audio);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > options.maxUploadBytes) throw new Error("INVALID_OUTPUT");
    const thumbnail = await optionalThumbnail(directory);
    const title = safeName(preferred?.title || info.title);
    const artist = safeName(preferred?.artist || info.artist);
    const raw = message.raw as ApiTypes.Message | undefined;
    if (!raw?.peerId) throw new Error("MISSING_PEER");
    await context.telegram.withClient(async (client, nativeSignal) => {
      const uploadSignal = AbortSignal.any([active, nativeSignal]);
      uploadSignal.throwIfAborted();
      const {Api} = await import("teleproto");
      await client.sendFile(raw.peerId, {
        file: audio,
        ...(thumbnail ? {thumb: thumbnail} : {}),
        forceDocument: false,
        attributes: [
          new Api.DocumentAttributeAudio({voice: false, duration: info.duration, title, performer: artist}),
          new Api.DocumentAttributeFilename({fileName: `${title} - ${artist}.mp3`}),
        ],
      });
      uploadSignal.throwIfAborted();
    });
    return {title, artist, duration: info.duration};
  });
}
