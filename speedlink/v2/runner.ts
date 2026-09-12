import {writeFile} from "node:fs/promises";
import path from "node:path";
import type {PluginContext} from "telebox/sdk";
import {parseTimeout, type Server} from "./config";

export type SpeedResult = {
  server: {id: string; name: string; location: string};
  isp: string; ping?: {latency: number; jitter?: number};
  download?: {bandwidth: number}; upload?: {bandwidth: number}; resultUrl?: string;
};

const speedtestCandidates = ["/usr/bin/speedtest", "/usr/local/bin/speedtest", "/opt/homebrew/bin/speedtest"];
const fixedArgs = ["--accept-license", "--accept-gdpr", "--format=json"];

function finite(value: unknown): number | undefined {
  const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function short(value: unknown, maximum = 120): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maximum);
}

function parse(stdout: Buffer): SpeedResult {
  if (stdout.length > 2 * 1024 * 1024) throw new Error("测速输出过大");
  let value: any;
  try { value = JSON.parse(stdout.toString("utf8")); } catch { throw new Error("测速程序未返回有效 JSON"); }
  const server = value?.server;
  if (!server || server.id === undefined) throw new Error("测速结果缺少服务器信息");
  const resultUrl = typeof value?.result?.url === "string" && /^https:\/\/www\.speedtest\.net\/result\/[A-Za-z0-9._-]+$/u.test(value.result.url)
    ? value.result.url : undefined;
  return {server: {id: short(server.id, 32), name: short(server.name), location: short(server.location)}, isp: short(value.isp),
    ...(finite(value?.ping?.latency) !== undefined ? {ping: {latency: finite(value.ping.latency)!, ...(finite(value?.ping?.jitter) !== undefined ? {jitter: finite(value.ping.jitter)} : {})}} : {}),
    ...(finite(value?.download?.bandwidth) !== undefined ? {download: {bandwidth: finite(value.download.bandwidth)!}} : {}),
    ...(finite(value?.upload?.bandwidth) !== undefined ? {upload: {bandwidth: finite(value.upload.bandwidth)!}} : {}),
    ...(resultUrl ? {resultUrl} : {})};
}

function timeoutMilliseconds(timeoutSeconds: number): number {
  const seconds = parseTimeout(timeoutSeconds);
  if (seconds === undefined) throw new Error("测速超时必须在 10 到 180 秒之间");
  return seconds * 1000;
}

function sshEnvironment(): NodeJS.ProcessEnv {
  const socket = process.env.SSH_AUTH_SOCK;
  return typeof socket === "string" && socket.length > 0 && !socket.includes("\0") ? {SSH_AUTH_SOCK: socket} : {};
}

async function localBinary(ctx: PluginContext, signal: AbortSignal = ctx.signal): Promise<string> {
  for (const candidate of speedtestCandidates) {
    try { await ctx.processes.run(candidate, ["--version"], {timeoutMs: 5_000, maxOutputBytes: 32 * 1024, signal}); return candidate; }
    catch { signal.throwIfAborted(); }
  }
  throw new Error("未找到官方 Ookla speedtest CLI，请由管理员安装");
}

function sshBinary(): string {
  if (process.platform === "win32") throw new Error("当前 V2 远程测速只支持提供 OpenSSH 的类 Unix 主机");
  return "/usr/bin/ssh";
}

async function pinnedKnownHost(ctx: PluginContext, server: Server, signal: AbortSignal): Promise<string> {
  const scan = await ctx.processes.run("/usr/bin/ssh-keyscan", ["-T", "10", "-p", String(server.port), server.host],
    {timeoutMs: 15_000, maxOutputBytes: 256 * 1024, signal});
  const keys = scan.stdout.toString("utf8").split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith("#")).slice(0, 12);
  for (const key of keys) {
    try {
      const checked = await ctx.processes.run("/usr/bin/ssh-keygen", ["-E", "sha256", "-lf", "-"],
        {input: `${key}\n`, timeoutMs: 5_000, maxOutputBytes: 32 * 1024, signal});
      if (checked.stdout.toString("utf8").split(/\s+/u).includes(server.fingerprint)) return key;
    } catch { signal.throwIfAborted(); }
  }
  throw new Error("远端主机指纹与保存值不一致");
}

export async function runLocal(ctx: PluginContext, timeoutSeconds: number, signal: AbortSignal = ctx.signal): Promise<SpeedResult> {
  const timeoutMs = timeoutMilliseconds(timeoutSeconds);
  const executable = await localBinary(ctx, signal);
  return parse((await ctx.processes.run(executable, fixedArgs, {timeoutMs, maxOutputBytes: 2 * 1024 * 1024, signal})).stdout);
}

export async function runRemote(ctx: PluginContext, server: Server, timeoutSeconds: number,
  callerSignal: AbortSignal = ctx.signal): Promise<SpeedResult> {
  const timeoutMs = timeoutMilliseconds(timeoutSeconds);
  const known = await pinnedKnownHost(ctx, server, callerSignal);
  return ctx.files.withTemp(async (directory, tempSignal) => {
    const signal = AbortSignal.any([tempSignal, callerSignal]);
    const knownHosts = path.join(directory, "known_hosts");
    await writeFile(knownHosts, `${known}\n`, {mode: 0o600, flag: "wx", signal});
    signal.throwIfAborted();
    const args = ["-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
      "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", `ConnectTimeout=${Math.min(30, timeoutSeconds)}`,
      "-p", String(server.port), `${server.username}@${server.host}`, "speedtest", ...fixedArgs];
    const result = await ctx.processes.run(sshBinary(), args, {timeoutMs, maxOutputBytes: 2 * 1024 * 1024,
      env: sshEnvironment(), signal});
    return parse(result.stdout);
  });
}

export async function dependencies(ctx: PluginContext): Promise<{local: boolean; ssh: boolean; keyscan: boolean; keygen: boolean}> {
  const probe = async (file: string, args: string[]) => {
    try { await ctx.processes.run(file, args, {timeoutMs: 5_000, maxOutputBytes: 32 * 1024}); return true; }
    catch (error) { return (error as {code?: string})?.code === "EXIT_FAILED"; }
  };
  const local = await localBinary(ctx).then(() => true, () => false);
  return {local, ssh: await probe(sshBinary(), ["-V"]), keyscan: await probe("/usr/bin/ssh-keyscan", ["-h"]), keygen: await probe("/usr/bin/ssh-keygen", ["-?"])};
}
