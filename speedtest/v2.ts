import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type CommandInvocation, type PluginContext} from "telebox/sdk";
import {
  DEFAULT_ORDER, migrateConfig, normalizeType, readConfig, updateConfig, type MessageType,
} from "./v2/config";
import {
  BEST_CANDIDATES, SPEEDTEST_VERSION, SpeedtestError, diagnose, installManaged, listServers,
  parseServerId, probeServer, resolveCli, runSpeedtest, type SpeedtestResult,
} from "./v2/cli";
import {deliverResult} from "./v2/report";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;"})[character]!);
const header = "<blockquote><b>⚡ SPEEDTEST by OOKLA</b></blockquote>";

function help(prefix: string): string {
  const command = `${prefix}speedtest`;
  return `<b>Speedtest 使用方法</b>\n` +
    `<code>${escape(command)}</code> - 自动测速\n` +
    `<code>${escape(command)} [服务器ID]</code> - 指定服务器测速\n` +
    `<code>${escape(command)} list</code> - 显示服务器列表\n` +
    `<code>${escape(command)} test [服务器ID]</code> - 对服务器执行一次实际测速探测\n` +
    `<code>${escape(command)} best</code> - 实测最多 ${BEST_CANDIDATES} 个候选并推荐\n` +
    `<code>${escape(command)} set [ID]</code> / <code>${escape(command)} clear</code>\n` +
    `<code>${escape(command)} type photo/sticker/file/txt</code>\n` +
    `<code>${escape(command)} config</code> / <code>${escape(command)} check</code>\n` +
    `<code>${escape(command)} diagnose</code> / <code>${escape(command)} fix</code> / <code>${escape(command)} update</code>\n\n` +
    `测速、列表、test、best 和 diagnose 可加 <code>--system</code> 或 <code>-s</code> 使用系统官方 Ookla CLI。`;
}

function argumentsOf(invocation: CommandInvocation): {args: string[]; system: boolean} {
  let system = false;
  const args: string[] = [];
  for (const value of invocation.args) {
    if (value === "--system" || value === "-s") system = true;
    else args.push(value);
  }
  return {args, system};
}

async function edit(context: PluginContext, invocation: CommandInvocation, text: string, html = false): Promise<void> {
  if (context.signal.aborted) return;
  await context.telegram.edit(invocation.message, text, html ? {parseMode: "html", linkPreview: false} : {});
}

async function networkCheck(context: PluginContext): Promise<{ok: boolean; message: string}> {
  try {
    const status = await context.http.withResponse("https://www.speedtest.net", {method: "HEAD"}, async response => response.status,
      {timeoutMs: 10_000, redirects: {allowedHosts: ["www.speedtest.net"], maxRedirects: 0}});
    return status >= 200 && status < 500 ? {ok: true, message: `网络连接正常（HTTP ${status}）`} : {ok: false, message: `Speedtest 官网返回 HTTP ${status}`};
  } catch (error) {
    context.signal.throwIfAborted();
    const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
    const messages: Record<string, string> = {DNS_FAILED: "DNS 解析失败", CONNECTION_REFUSED: "连接被拒绝", TIMEOUT: "连接超时"};
    return {ok: false, message: messages[String(code)] ?? "网络连接检查失败"};
  }
}

function brief(result: SpeedtestResult): string {
  const rate = (bandwidth: number | undefined) => bandwidth === undefined ? "失败" : `${Math.round(bandwidth * 8 / 10_000) / 100} Mbps`;
  return `${header}\n<code>服务器</code> <code>${result.server.id} / ${escape(result.server.name)} / ${escape(result.server.location)}</code>\n` +
    `<code>实际延迟</code> <code>${result.ping ? `${result.ping.latency} ms` : "失败"}</code>\n` +
    `<code>下行</code> <code>${rate(result.download?.bandwidth)}</code> <code>上行 ${rate(result.upload?.bandwidth)}</code>`;
}

function userMessage(error: unknown): string {
  return error instanceof SpeedtestError ? error.message : "Speedtest 操作失败，请运行 diagnose 检查 CLI 和网络";
}

function logCommand(sub: string): string {
  const known = new Set(["help", "h", "set", "clear", "type", "config", "check", "diagnose", "fix", "update", "list", "test", "best"]);
  if (!sub || parseServerId(sub) !== undefined) return "run";
  return known.has(sub) ? sub : "invalid";
}

export default function createSpeedtest() {
  let tail: Promise<void> = Promise.resolve();
  const serial = async <T>(context: PluginContext, operation: () => Promise<T>): Promise<T> => {
    const previous = tail.catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    tail = previous.then(() => gate);
    try {
      return await context.tasks.run("speedtest:serial", async signal => {
        await previous;
        signal.throwIfAborted();
        return operation();
      });
    } finally {
      // Also release a queued operation that is cancelled before its callback starts.
      release();
    }
  };

  const install = (context: PluginContext) => installManaged(context);
  const command = {description: "使用官方 Ookla CLI 测量网络速度", async handle(invocation: CommandInvocation, context: PluginContext) {
    const {args, system} = argumentsOf(invocation);
    const sub = (args[0] ?? "").toLowerCase();
    try {
      if (sub === "help" || sub === "h") { await edit(context, invocation, help(invocation.prefix), true); return; }
      if (sub === "set") {
        const id = parseServerId(args[1]);
        if (id === undefined || args.length !== 2) throw new SpeedtestError("请提供 1 到 Number.MAX_SAFE_INTEGER 范围内的十进制服务器 ID");
        await updateConfig(context, {default_server_id: id});
        await edit(context, invocation, `${header}\n<code>默认服务器已设置为 ${id}</code>`, true); return;
      }
      if (sub === "clear") {
        await updateConfig(context, {default_server_id: null});
        await edit(context, invocation, `${header}\n<code>默认服务器已清除</code>`, true); return;
      }
      if (sub === "type") {
        const preferred = normalizeType((args[1] ?? "").toLowerCase());
        if (!preferred || args.length !== 2) throw new SpeedtestError("输出类型必须是 photo、sticker、file 或 txt");
        await updateConfig(context, {preferred_type: preferred});
        const order = [preferred, ...DEFAULT_ORDER.filter(value => value !== preferred)];
        await edit(context, invocation, `${header}\n<code>优先类型：${preferred}</code>\n<code>回退顺序：${order.join(" → ")}</code>`, true); return;
      }
      if (sub === "config") {
        const state = await readConfig(context);
        await edit(context, invocation, `${header}\n<code>默认服务器：${state.default_server_id ?? "Auto"}</code>\n` +
          `<code>优先类型：${state.preferred_type ?? "默认(photo → sticker → file → txt)"}</code>\n` +
          `<code>Speedtest CLI：${SPEEDTEST_VERSION}</code>`, true); return;
      }
      if (sub === "check") {
        await edit(context, invocation, "正在检查 Speedtest 官网连通性…");
        const result = await networkCheck(context);
        await edit(context, invocation, `${header}\n<code>${escape(result.message)}</code>\n<code>此命令未执行测速</code>`, true); return;
      }
      if (sub === "diagnose") {
        await edit(context, invocation, "正在诊断 Speedtest CLI…");
        const result = await serial(context, () => diagnose(context, system));
        await edit(context, invocation, `${header}\n<code>${result.ok ? "正常" : "异常"}：${escape(result.message)}</code>\n` +
          (result.path ? `<code>路径：${escape(result.path)}</code>\n` : "") +
          (result.version ? `<code>版本：${escape(result.version)}</code>` : ""), true); return;
      }
      if (sub === "fix" || sub === "update") {
        await edit(context, invocation, sub === "fix" ? "正在修复托管 Speedtest CLI…" : "正在更新托管 Speedtest CLI…");
        const executable = await serial(context, () => install(context));
        await edit(context, invocation, `${header}\n<code>托管 Speedtest CLI ${sub === "fix" ? "修复" : "更新"}完成</code>\n<code>路径：${escape(executable)}</code>`, true); return;
      }
      if (sub === "list") {
        await edit(context, invocation, "正在获取 Speedtest 服务器列表…");
        const servers = await serial(context, async () => {
          const executable = await resolveCli(context, system, () => install(context));
          return listServers(context, executable);
        });
        if (!servers.length) throw new SpeedtestError("未获取到可用服务器");
        await edit(context, invocation, `${header}\n${servers.map(server => `<code>${server.id}</code> - <code>${escape(server.name)}</code> - <code>${escape(server.location)}</code>`).join("\n")}`, true); return;
      }
      if (sub === "test") {
        const id = parseServerId(args[1]);
        if (id === undefined || args.length !== 2) throw new SpeedtestError("test 需要一个有效的十进制服务器 ID");
        await edit(context, invocation, `正在对服务器 ${id} 执行实际测速探测…`);
        const result = await serial(context, async () => {
          const executable = await resolveCli(context, system, () => install(context));
          return probeServer(context, executable, id);
        });
        await edit(context, invocation, `${brief(result)}\n<code>该结果来自一次实际测速，不是列表推断</code>`, true); return;
      }
      if (sub === "best") {
        await edit(context, invocation, `正在实测最多 ${BEST_CANDIDATES} 个候选服务器…`);
        const results = await serial(context, async () => {
          const executable = await resolveCli(context, system, () => install(context));
          const candidates = (await listServers(context, executable)).slice(0, BEST_CANDIDATES);
          const measured: SpeedtestResult[] = [];
          for (const candidate of candidates) {
            context.signal.throwIfAborted();
            try { measured.push(await probeServer(context, executable, candidate.id)); }
            catch { context.signal.throwIfAborted(); }
          }
          return measured.sort((left, right) => (left.ping?.latency ?? Number.POSITIVE_INFINITY) - (right.ping?.latency ?? Number.POSITIVE_INFINITY));
        });
        if (!results.length) throw new SpeedtestError("候选服务器实际测速均失败，请稍后重试");
        await edit(context, invocation, `${header}\n<b>实测推荐服务器</b>\n${results.map((result, index) =>
          `${index + 1}. <code>${result.server.id}</code> <code>${escape(result.server.name)}</code> <code>${result.ping?.latency ?? "延迟失败"} ms</code>`).join("\n")}\n` +
          `<code>已实际测速 ${results.length}/${BEST_CANDIDATES} 个有界候选</code>`, true); return;
      }

      const directId = sub ? parseServerId(args[0]) : undefined;
      if (sub && directId === undefined || args.length > (sub ? 1 : 0)) throw new SpeedtestError(help(invocation.prefix));
      await edit(context, invocation, "正在检查网络连接…");
      const connectivity = await networkCheck(context);
      if (!connectivity.ok) throw new SpeedtestError(`${connectivity.message}，无法开始测速`);
      await edit(context, invocation, "网络连接正常，正在进行实际速度测试…");
      const state = await readConfig(context);
      const id = directId ?? state.default_server_id ?? undefined;
      const result = await serial(context, async () => {
        const executable = await resolveCli(context, system, () => install(context));
        return runSpeedtest(context, executable, id);
      });
      if (context.signal.aborted) return;
      await deliverResult(context, invocation, result, state.preferred_type);
    } catch (error) {
      if (context.signal.aborted) return;
      context.log.error("speedtest_command_failed", {command: logCommand(sub)});
      const message = userMessage(error);
      await edit(context, invocation, message.includes("<b>") ? message : `❌ <b>Speedtest 操作失败</b>\n<code>${escape(message)}</code>`, true);
    }
  }};

  return definePlugin({renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "speedtest",
    description: "使用官方 Ookla CLI 的网络测速工具",
    resources: {processes: {concurrency: 1, queueCapacity: 3, timeoutMs: 180_000, maxOutputBytes: 2 * 1024 * 1024}},
    commands: {speedtest: {...command, helpArgs: ["help","h"]}, st: {...command, helpArgs: ["help","h"]}},
    settings: context => ({
      id: "speedtest", title: "Speedtest 测速", description: "网络测速配置", category: "插件配置", icon: "🚀",
      getSchema: () => [
        {key: "default_server_id", label: "默认服务器 ID", type: "number", min: 1, max: Number.MAX_SAFE_INTEGER,
          description: "留空时由 Ookla 自动选择"},
        {key: "preferred_type", label: "首选消息类型", type: "select", options: [
          {value: "photo", label: "图片"}, {value: "sticker", label: "贴纸"}, {value: "file", label: "文件"}, {value: "txt", label: "文本"},
        ]},
      ],
      async getValues() { const value = await readConfig(context); return {default_server_id: value.default_server_id, preferred_type: value.preferred_type}; },
      async setValues(patch) {
        const next: {default_server_id?: number | null; preferred_type?: MessageType | null} = {};
        if (Object.hasOwn(patch, "default_server_id")) {
          if (patch.default_server_id !== null && (typeof patch.default_server_id !== "number" || !Number.isSafeInteger(patch.default_server_id) || patch.default_server_id <= 0)) throw new Error("invalid server id");
          next.default_server_id = patch.default_server_id as number | null;
        }
        if (Object.hasOwn(patch, "preferred_type")) {
          const preferred = normalizeType(patch.preferred_type);
          if (!preferred) throw new Error("invalid message type");
          next.preferred_type = preferred;
        }
        await updateConfig(context, next);
      },
    }),
    async setup(context) { await migrateConfig(context); },
    async cleanup() { await tail.catch(() => undefined); tail = Promise.resolve(); },
  });
}
