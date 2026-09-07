import {randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {
  access, chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm,
} from "node:fs/promises";
import path from "node:path";
import type {PluginContext} from "telebox/sdk";

export const SPEEDTEST_VERSION = "1.2.0";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_SERVERS = 20;
export const BEST_CANDIDATES = 3;

export type ServerInfo = {id: number; name: string; location: string; distance?: number};
export type Transfer = {bandwidth: number; bytes: number};
export type SpeedtestResult = {
  isp: string;
  server: {id: number; name: string; location: string};
  interface: {externalIp: string; name: string};
  ping?: {latency: number; jitter?: number};
  download?: Transfer;
  upload?: Transfer;
  timestamp?: string;
  result?: {url: string};
};

export class SpeedtestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeedtestError";
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function short(value: unknown, maximum = 96): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function serverId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function parseServerId(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function transfer(value: unknown): Transfer | undefined {
  const item = object(value);
  const bandwidth = finite(item?.bandwidth);
  const bytes = finite(item?.bytes);
  return bandwidth === undefined || bytes === undefined ? undefined : {bandwidth, bytes};
}

export function parseSpeedtestResult(text: string): SpeedtestResult {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new SpeedtestError("Speedtest CLI 未返回有效 JSON，请运行 diagnose 检查安装"); }
  const root = object(value);
  const rawServer = object(root?.server);
  const id = serverId(rawServer?.id);
  if (!root || !rawServer || id === undefined) throw new SpeedtestError("Speedtest CLI 结果缺少有效服务器信息");
  const rawInterface = object(root.interface);
  const rawPing = object(root.ping);
  const latency = finite(rawPing?.latency);
  const download = transfer(root.download);
  const upload = transfer(root.upload);
  if (latency === undefined && !download && !upload) {
    throw new SpeedtestError("Speedtest CLI 未返回任何实际探测结果");
  }
  return {
    isp: short(root.isp),
    server: {id, name: short(rawServer.name), location: short(rawServer.location)},
    interface: {externalIp: short(rawInterface?.externalIp, 64), name: short(rawInterface?.name, 64)},
    ...(latency === undefined ? {} : {ping: {latency, ...(finite(rawPing?.jitter) === undefined ? {} : {jitter: finite(rawPing?.jitter)})}}),
    ...(download ? {download} : {}),
    ...(upload ? {upload} : {}),
    ...(short(root.timestamp, 64) ? {timestamp: short(root.timestamp, 64)} : {}),
    ...(short(object(root.result)?.url, 256) ? {result: {url: short(object(root.result)?.url, 256)}} : {}),
  };
}

function output(error: unknown, name: "stdout" | "stderr"): string {
  if (!error || typeof error !== "object") return "";
  const descriptor = Object.getOwnPropertyDescriptor(error, name);
  return descriptor && "value" in descriptor && Buffer.isBuffer(descriptor.value) ? descriptor.value.toString("utf8") : "";
}

function code(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : "";
}

function processFailure(error: unknown): never {
  const kind = code(error);
  if (kind === "TIMED_OUT") throw new SpeedtestError("Speedtest CLI 执行超时，请稍后重试或更换服务器");
  if (kind === "OUTPUT_LIMIT") throw new SpeedtestError("Speedtest CLI 输出超过 2 MiB 安全上限");
  if (kind === "SPAWN_FAILED") throw new SpeedtestError("Speedtest CLI 无法启动；请运行 diagnose，托管模式可运行 fix，系统模式请安装官方 Ookla CLI");
  const diagnostic = output(error, "stderr");
  if (/NoServersException|Server not found/i.test(diagnostic)) throw new SpeedtestError("指定服务器不可用，请运行 list 选择其他服务器");
  if (/timeout|Cannot read|socket/i.test(diagnostic)) throw new SpeedtestError("Speedtest CLI 网络连接失败或超时，请检查网络后重试");
  throw new SpeedtestError("Speedtest CLI 执行失败；请运行 diagnose 检查安装和网络");
}

async function runResult(context: PluginContext, executable: string, id: number | undefined, timeoutMs: number): Promise<SpeedtestResult> {
  const args = ["--accept-license", "--accept-gdpr", "--format=json", "--progress=no"];
  if (id !== undefined) args.push("--server-id", String(id));
  try {
    const result = await context.processes.run(executable, args, {timeoutMs, maxOutputBytes: 2 * 1024 * 1024});
    if (!result.stdout.length) throw new SpeedtestError("Speedtest CLI 返回空结果，测速未完成");
    return parseSpeedtestResult(result.stdout.toString("utf8"));
  } catch (error) {
    context.signal.throwIfAborted();
    const partial = output(error, "stdout");
    if (partial.trim()) {
      try { return parseSpeedtestResult(partial); } catch { /* Report the bounded process failure below. */ }
    }
    if (error instanceof SpeedtestError) throw error;
    return processFailure(error);
  }
}

async function ordinaryFile(file: string, maximum = MAX_BINARY_BYTES): Promise<boolean> {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum;
  } catch { return false; }
}

export function managedPath(context: PluginContext): string {
  return context.files.dataPath(process.platform === "win32" ? "speedtest.exe" : "speedtest");
}

async function knownSystemPath(context: PluginContext): Promise<string | undefined> {
  const name = process.platform === "win32" ? "speedtest.exe" : "speedtest";
  const candidates = new Set<string>();
  if (process.platform === "win32") {
    const root = process.env.SystemRoot;
    if (root && path.isAbsolute(root)) candidates.add(path.join(root, "System32", name));
  } else {
    for (const directory of ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]) candidates.add(path.join(directory, name));
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory && path.isAbsolute(directory)) candidates.add(path.join(directory, name));
  }
  const managed = path.resolve(managedPath(context));
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      if (path.resolve(resolved) === managed || !await ordinaryFile(resolved)) continue;
      if (process.platform !== "win32") await access(resolved, constants.X_OK);
      return resolved;
    } catch { /* Continue through the bounded local candidate set. */ }
  }
  return undefined;
}

async function version(context: PluginContext, executable: string): Promise<string> {
  try {
    const result = await context.processes.run(executable, ["--version"], {timeoutMs: 10_000, maxOutputBytes: 64 * 1024});
    const text = result.stdout.toString("utf8").trim();
    if (!/Speedtest by Ookla/i.test(text)) throw new SpeedtestError("检测到的程序不是官方 Ookla Speedtest CLI");
    return text.slice(0, 160);
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof SpeedtestError) throw error;
    return processFailure(error);
  }
}

export async function resolveCli(context: PluginContext, system: boolean, install: () => Promise<string>): Promise<string> {
  if (system) {
    const executable = await knownSystemPath(context);
    if (!executable) throw new SpeedtestError("系统未安装官方 Ookla Speedtest CLI；请按 speedtest.net/apps/cli 安装，或移除 --system 使用托管版本");
    await version(context, executable);
    return executable;
  }
  const executable = managedPath(context);
  if (!await ordinaryFile(executable)) return install();
  return executable;
}

export async function diagnose(context: PluginContext, system: boolean): Promise<{ok: boolean; path?: string; version?: string; message: string}> {
  try {
    const executable = system ? await knownSystemPath(context) : managedPath(context);
    if (!executable || !await ordinaryFile(executable)) {
      return {ok: false, message: system ? "未找到官方系统 CLI；请按 speedtest.net/apps/cli 安装" : "托管 CLI 不存在；请运行 speedtest fix 安装"};
    }
    const value = await version(context, executable);
    return {ok: true, path: executable, version: value, message: "官方 Ookla CLI 可正常启动"};
  } catch (error) {
    context.signal.throwIfAborted();
    return {ok: false, message: error instanceof SpeedtestError ? error.message : "CLI 诊断失败"};
  }
}

type PackageInfo = {fileName: string; executableName: string; archive: "tgz" | "zip"};

function packageInfo(): PackageInfo {
  if (process.platform === "linux") {
    const architectures: Record<string, string> = {x64: "x86_64", arm64: "aarch64", arm: "armhf", ia32: "i386"};
    const architecture = architectures[process.arch];
    if (!architecture) throw new SpeedtestError(`官方 Speedtest CLI 1.2.0 不支持当前 Linux 架构 ${process.arch}`);
    return {fileName: `ookla-speedtest-${SPEEDTEST_VERSION}-linux-${architecture}.tgz`, executableName: "speedtest", archive: "tgz"};
  }
  if (process.platform === "darwin") {
    if (process.arch !== "x64" && process.arch !== "arm64") throw new SpeedtestError(`官方 Speedtest CLI 1.2.0 不支持当前 macOS 架构 ${process.arch}`);
    return {fileName: `ookla-speedtest-${SPEEDTEST_VERSION}-macosx-universal.tgz`, executableName: "speedtest", archive: "tgz"};
  }
  if (process.platform === "win32") {
    if (process.arch !== "x64") throw new SpeedtestError(`官方 Speedtest CLI 1.2.0 不支持当前 Windows 架构 ${process.arch}`);
    return {fileName: `ookla-speedtest-${SPEEDTEST_VERSION}-win64.zip`, executableName: "speedtest.exe", archive: "zip"};
  }
  throw new SpeedtestError(`官方 Speedtest CLI 1.2.0 不支持当前平台 ${process.platform}`);
}

async function tarPath(): Promise<string> {
  let candidate: string;
  if (process.platform === "win32") {
    const root = process.env.SystemRoot;
    if (!root || !path.isAbsolute(root)) throw new SpeedtestError("找不到 Windows 系统 tar.exe，无法安全解压官方 CLI");
    candidate = path.join(root, "System32", "tar.exe");
  } else {
    candidate = "/usr/bin/tar";
  }
  try {
    const resolved = await realpath(candidate);
    if (!await ordinaryFile(resolved)) throw new Error("invalid tar");
    if (process.platform !== "win32") await access(resolved, constants.X_OK);
    return resolved;
  } catch {
    throw new SpeedtestError("系统 tar 不可用，无法安全解压官方 CLI");
  }
}

async function downloadArchive(context: PluginContext, url: URL, destination: string): Promise<void> {
  await context.http.withResponse(url, {method: "GET"}, async (response, signal) => {
    if (response.status !== 200 || !response.body) throw new Error("download rejected");
    const lengthHeader = response.headers.get("content-length");
    const expected = lengthHeader === null ? undefined : Number(lengthHeader);
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_ARCHIVE_BYTES)) {
      throw new Error("download size rejected");
    }
    const reader = response.body.getReader();
    const file = await open(destination, "wx", 0o600);
    let total = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MAX_ARCHIVE_BYTES || expected !== undefined && total > expected) throw new Error("download size rejected");
        await file.write(chunk.value);
      }
      if (total === 0) throw new Error("empty download");
      if (expected !== undefined && total !== expected) throw new Error("truncated download");
    } finally {
      await file.close();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }, {timeoutMs: 120_000, redirects: {allowedHosts: ["install.speedtest.net"], maxRedirects: 0}});
}

async function replaceManaged(context: PluginContext, source: string, target: string): Promise<void> {
  const directory = await context.files.dataDirectory();
  const stage = path.join(directory, `.speedtest-${randomUUID()}.new`);
  const backup = path.join(directory, `.speedtest-${randomUUID()}.previous`);
  let backedUp = false;
  try {
    await copyFile(source, stage, constants.COPYFILE_EXCL);
    if (process.platform !== "win32") await chmod(stage, 0o700);
    if (!await ordinaryFile(stage)) throw new SpeedtestError("解压后的 CLI 文件无效");
    if (await ordinaryFile(target) && process.platform === "win32") {
      await rename(target, backup);
      backedUp = true;
    }
    try { await rename(stage, target); }
    catch (error) {
      if (backedUp) await rename(backup, target).catch(() => undefined);
      throw error;
    }
    if (backedUp) await rm(backup, {force: true});
  } finally {
    await rm(stage, {force: true}).catch(() => undefined);
    if (backedUp && !await ordinaryFile(target) && await ordinaryFile(backup)) await rename(backup, target).catch(() => undefined);
    await rm(backup, {force: true}).catch(() => undefined);
  }
}

export async function installManaged(context: PluginContext): Promise<string> {
  const info = packageInfo();
  const target = managedPath(context);
  const current = await lstat(target).catch(() => undefined);
  if (current && (current.isSymbolicLink() || !current.isFile())) throw new SpeedtestError("托管 CLI 路径不是普通文件，请管理员检查 assets/speedtest");
  try {
    await context.files.withTemp(async (directory, signal) => {
      const archive = path.join(directory, info.fileName);
      const extractedDirectory = path.join(directory, "extracted");
      const extracted = path.join(extractedDirectory, info.executableName);
      await mkdir(extractedDirectory, {mode: 0o700});
      const url = new URL(`https://install.speedtest.net/app/cli/${info.fileName}`);
      await downloadArchive(context, url, archive);
      signal.throwIfAborted();
      if (!await ordinaryFile(archive, MAX_ARCHIVE_BYTES)) throw new SpeedtestError("官方 CLI 安装包不是有效普通文件");
      const tar = await tarPath();
      const flags = info.archive === "tgz" ? "-xzf" : "-xf";
      await context.processes.run(tar, [flags, archive, "-C", extractedDirectory, info.executableName], {
        timeoutMs: 60_000, maxOutputBytes: 256 * 1024,
      });
      if (!await ordinaryFile(extracted)) throw new SpeedtestError("官方安装包未包含预期的 Speedtest CLI 文件");
      if (process.platform !== "win32") await chmod(extracted, 0o700);
      await version(context, extracted);
      signal.throwIfAborted();
      await replaceManaged(context, extracted, target);
    });
    return target;
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof SpeedtestError) throw error;
    throw new SpeedtestError("托管 CLI 安装失败；已保留原版本，请检查网络、磁盘空间和系统 tar 后重试");
  }
}

export async function listServers(context: PluginContext, executable: string): Promise<ServerInfo[]> {
  try {
    const result = await context.processes.run(executable,
      ["--accept-license", "--accept-gdpr", "--format=json", "--servers"],
      {timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024});
    if (!result.stdout.length) throw new SpeedtestError("Speedtest CLI 返回空服务器列表");
    const root = object(JSON.parse(result.stdout.toString("utf8")));
    if (!Array.isArray(root?.servers)) throw new SpeedtestError("Speedtest CLI 服务器列表格式无效");
    return root.servers.flatMap(value => {
      const item = object(value);
      const id = serverId(item?.id);
      if (id === undefined) return [];
      const distance = finite(item?.distance);
      return [{id, name: short(item?.name), location: short(item?.location), ...(distance === undefined ? {} : {distance})}];
    }).slice(0, MAX_SERVERS);
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof SpeedtestError) throw error;
    if (error instanceof SyntaxError) throw new SpeedtestError("Speedtest CLI 服务器列表格式无效");
    return processFailure(error);
  }
}

export const runSpeedtest = (context: PluginContext, executable: string, id?: number) =>
  runResult(context, executable, id, 120_000);

export const probeServer = (context: PluginContext, executable: string, id: number) =>
  runResult(context, executable, id, 45_000);
