import {definePlugin, type PluginContext} from "telebox/sdk";

const translations: ReadonlyArray<readonly [RegExp, string]> = [
  [/active \(running\)/g, "活跃 (运行中)"],
  [/inactive \(dead\)/g, "已停止 (未运行)"],
  [/\bfailed\b/g, "失败"],
  [/\bactivating\b/g, "启动中"],
  [/\bdeactivating\b/g, "停止中"],
  [/Main PID:/g, "主进程PID:"],
  [/Tasks:/g, "任务数:"],
  [/Memory:/g, "内存:"],
  [/CPU:/g, "CPU使用:"],
];

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[character]!);

function serviceName(value: string): string | undefined {
  return /^[A-Za-z0-9_.@\\-]+$/.test(value) && value.length <= 128 ? value : undefined;
}

function translate(value: string): string {
  let result = value;
  for (const [pattern, replacement] of translations) result = result.replace(pattern, replacement);
  return result.replace(/(\d+(?:\.\d+)?)h\b/g, "$1小时").replace(/(\d+(?:\.\d+)?)min\b/g, "$1分钟");
}

function captured(error: unknown): string {
  const value = error as {stdout?: Uint8Array; stderr?: Uint8Array};
  return `${value?.stdout ? Buffer.from(value.stdout).toString("utf8") : ""}\n${value?.stderr ? Buffer.from(value.stderr).toString("utf8") : ""}`;
}

async function run(ctx: PluginContext, file: string, args: readonly string[], timeoutMs = 8_000) {
  return ctx.processes.run(file, args, {timeoutMs, maxOutputBytes: 64 * 1024});
}

async function detect(ctx: PluginContext): Promise<string> {
  try {
    const result = await run(ctx, "/usr/bin/ps", ["-o", "unit=", "-p", String(process.pid)]);
    const unit = result.stdout.toString("utf8").trim();
    if (unit && unit !== "-" && serviceName(unit)) return unit.endsWith(".service") ? unit.slice(0, -8) : unit;
  } catch {}
  for (const candidate of ["pagermaid", "pgm", "pagermaid-modify", "pgm-sg", "pgm-hk"]) {
    try {
      const result = await run(ctx, "/usr/bin/systemctl", ["is-active", candidate]);
      if (result.stdout.toString("utf8").trim() === "active") return candidate;
    } catch {}
  }
  return "pagermaid";
}

export default function createService() {
  return definePlugin({apiVersion: 1, id: "service", description: "查看 systemd 服务状态",
    resources: {processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 8_000, maxOutputBytes: 64 * 1024}},
    commands: {service: {description: "查看指定或当前 systemd 服务状态", async handle({message, args}, ctx) {
      let name: string;
      let automatic = false;
      if (args[0]) {
        const checked = serviceName(args[0]);
        if (!checked) {
          await ctx.telegram.edit(message, "❌ 服务名称包含非法字符，只允许字母、数字、-、_、.和@");
          return;
        }
        name = checked;
      } else {
        automatic = true;
        await ctx.telegram.edit(message, "🔍 正在自动检测当前服务...");
        name = await detect(ctx);
      }
      await ctx.telegram.edit(message, `🔍 正在检查 ${escape(name)} 服务状态...`);
      try {
        const result = await run(ctx, "/usr/bin/systemctl", ["--no-pager", "status", name]);
        const raw = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`;
        if (/could not be found|not be found|Loaded:\s+not-found/i.test(raw)) {
          await ctx.telegram.edit(message, `❌ 服务 '${name}' 未找到。`);
          return;
        }
        if (/Active:\s+inactive/i.test(raw)) {
          await ctx.telegram.edit(message, `🔴 服务 '${name}' 已停止 (未运行)。`);
          return;
        }
        const details = raw.split("\n").filter(line => /Active|PID|Tasks|Memory|CPU|limit|high|max|available/i.test(line)).map(line => line.trim()).join("\n");
        const body = translate(details || "未返回可识别的状态字段");
        const emoji = body.includes("活跃 (运行中)") ? "🟢" : "🟡";
        await ctx.telegram.edit(message, `${emoji} <b>${escape(name)} 服务详情${automatic ? " (自动检测)" : ""}</b>\n<pre>${escape(body)}</pre>`, {parseMode:"html"});
      } catch (error) {
        if (ctx.signal.aborted) return;
        const output = captured(error);
        if (/could not be found|not be found|Loaded:\s+not-found/i.test(output)) {
          await ctx.telegram.edit(message, `❌ 服务 '${name}' 未找到。`);
        } else if (/Active:\s+inactive/i.test(output)) {
          await ctx.telegram.edit(message, `🔴 服务 '${name}' 已停止 (未运行)。`);
        } else {
          await ctx.telegram.edit(message, `❌ 获取服务详情时发生错误: ${escape(error instanceof Error ? error.message : error)}`);
        }
      }
    }}},
  });
}
