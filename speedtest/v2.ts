import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, resolveHelpPath, resolveSubcommandName, dispatchCommand, type CommandDefinition, definePlugin, type CommandInvocation, type PluginContext} from "telebox/sdk";
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
  const guarded = (action: string | undefined, operation: (i: CommandInvocation, context: PluginContext, args: string[], system: boolean) => Promise<void>): CommandDefinition["handle"] => async (i, context) => {
    const {args, system} = argumentsOf(i);
    const sub = action ?? (args[0] ?? "").toLowerCase();
    try {
      const path = resolveHelpPath(command, [...(i.subcommands ?? []), ...args], command.helpArgs);
      if (path) { await edit(context, i, renderCommandHelp(i.command, command, {prefix: i.prefix, title: "⚡ Speedtest 使用方法", path}), true); return; }
      await operation(i, context, args, system);
    } catch(error) {
      if (context.signal.aborted) return;
      context.log.error("speedtest_command_failed", {command: logCommand(sub)});
      const message = userMessage(error);
      await edit(context, i, message.includes("<b>") ? message : `❌ <b>Speedtest 操作失败</b>\n<code>${escape(message)}</code>`, true);
    }
  };
  const maintain = (sub: "fix" | "update") => guarded(sub, async (invocation, context) => {

        await edit(context, invocation, sub === "fix" ? "正在修复托管 Speedtest CLI…" : "正在更新托管 Speedtest CLI…");
        const executable = await serial(context, () => install(context));
        await edit(context, invocation, `${header}\n<code>托管 Speedtest CLI ${sub === "fix" ? "修复" : "更新"}完成</code>\n<code>路径：${escape(executable)}</code>`, true); return;

  });
  const runDefault = guarded(undefined, async (invocation, context, args, system) => {
    const sub = (args[0] ?? "").toLowerCase();
    if (sub === "help" || sub === "h") { await edit(context, invocation, help(invocation.prefix), true); return; }
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

  });
  const command: CommandDefinition = {
    description: "使用官方 Ookla CLI 测量网络速度", helpArgs: ["help", "h"], args: "[服务器ID] [--system|-s]", subcommandsCaseSensitive: false,
    examples: [{args: "", description: "使用默认服务器或自动选择"}, {args: "12345"}, {args: "--system"}, {args: "-s 12345"}],
    subcommands: {
      set: {description: "设置默认服务器", args: "ID", arguments: [{name: "ID", required: true, description: "1 至 Number.MAX_SAFE_INTEGER 范围内的十进制整数"}], handle: guarded("set", async (invocation, context, args, system) => {

        const id = parseServerId(args[0]);
        if (id === undefined || args.length !== 1) throw new SpeedtestError("请提供 1 到 Number.MAX_SAFE_INTEGER 范围内的十进制服务器 ID");
        await updateConfig(context, {default_server_id: id});
        await edit(context, invocation, `${header}\n<code>默认服务器已设置为 ${id}</code>`, true); return;

      })},
      clear: {description: "清除默认服务器", args: "", handle: guarded("clear", async (invocation, context, args, system) => {

        await updateConfig(context, {default_server_id: null});
        await edit(context, invocation, `${header}\n<code>默认服务器已清除</code>`, true); return;

      })},
      type: {description: "设置优先消息类型", args: "photo|sticker|file|txt", arguments: [{name: "类型", description: "支持 text 作为 txt 的别名；首选失败后按 photo → sticker → file → txt 其余类型回退"}], handle: guarded("type", async (invocation, context, args, system) => {

        const preferred = normalizeType((args[0] ?? "").toLowerCase());
        if (!preferred || args.length !== 1) throw new SpeedtestError("输出类型必须是 photo、sticker、file 或 txt");
        await updateConfig(context, {preferred_type: preferred});
        const order = [preferred, ...DEFAULT_ORDER.filter(value => value !== preferred)];
        await edit(context, invocation, `${header}\n<code>优先类型：${preferred}</code>\n<code>回退顺序：${order.join(" → ")}</code>`, true); return;

      })},
      config: {description: "显示默认服务器、首选输出与 CLI 版本", args: "", handle: guarded("config", async (invocation, context, args, system) => {

        const state = await readConfig(context);
        await edit(context, invocation, `${header}\n<code>默认服务器：${state.default_server_id ?? "Auto"}</code>\n` +
          `<code>优先类型：${state.preferred_type ?? "默认(photo → sticker → file → txt)"}</code>\n` +
          `<code>Speedtest CLI：${SPEEDTEST_VERSION}</code>`, true); return;

      })},
      check: {description: "检查官网网络连通性", args: "", help: [{heading: "检查范围：", body: "请求 Speedtest 官网，检查连接状态；不执行测速。"}], handle: guarded("check", async (invocation, context, args, system) => {

        await edit(context, invocation, "正在检查 Speedtest 官网连通性…");
        const result = await networkCheck(context);
        await edit(context, invocation, `${header}\n<code>${escape(result.message)}</code>\n<code>此命令未执行测速</code>`, true); return;

      })},
      diagnose: {description: "诊断 CLI 路径与版本", args: "[--system|-s]", handle: guarded("diagnose", async (invocation, context, args, system) => {

        await edit(context, invocation, "正在诊断 Speedtest CLI…");
        const result = await serial(context, () => diagnose(context, system));
        await edit(context, invocation, `${header}\n<code>${result.ok ? "正常" : "异常"}：${escape(result.message)}</code>\n` +
          (result.path ? `<code>路径：${escape(result.path)}</code>\n` : "") +
          (result.version ? `<code>版本：${escape(result.version)}</code>` : ""), true); return;

      })},
      list: {description: "显示可用服务器列表", args: "[--system|-s]", handle: guarded("list", async (invocation, context, args, system) => {

        await edit(context, invocation, "正在获取 Speedtest 服务器列表…");
        const servers = await serial(context, async () => {
          const executable = await resolveCli(context, system, () => install(context));
          return listServers(context, executable);
        });
        if (!servers.length) throw new SpeedtestError("未获取到可用服务器");
        await edit(context, invocation, `${header}\n${servers.map(server => `<code>${server.id}</code> - <code>${escape(server.name)}</code> - <code>${escape(server.location)}</code>`).join("\n")}`, true); return;

      })},
      test: {description: "对指定服务器执行一次实际测速探测", args: "ID [--system|-s]", examples: [{args: "test 12345 --system"}], handle: guarded("test", async (invocation, context, args, system) => {

        const id = parseServerId(args[0]);
        if (id === undefined || args.length !== 1) throw new SpeedtestError("test 需要一个有效的十进制服务器 ID");
        await edit(context, invocation, `正在对服务器 ${id} 执行实际测速探测…`);
        const result = await serial(context, async () => {
          const executable = await resolveCli(context, system, () => install(context));
          return probeServer(context, executable, id);
        });
        await edit(context, invocation, `${brief(result)}\n<code>该结果来自一次实际测速，不是列表推断</code>`, true); return;

      })},
      best: {description: "实测候选服务器并按延迟推荐", args: "[--system|-s]", help: [{heading: "候选数量：", body: `最多实测 ${BEST_CANDIDATES} 个候选，结果来自实际测速。`}], handle: guarded("best", async (invocation, context, args, system) => {

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

      })},
      fix: {description: "修复托管 Speedtest CLI", args: "", handle: maintain("fix")},
      update: {description: "更新托管 Speedtest CLI", args: "", handle: maintain("update")},
    },
    help: [{heading: "测速与系统 CLI：", body: "使用官方 Ookla CLI。测速、list、test、best、diagnose 可加 --system 或 -s 使用系统安装的官方 CLI，标志可放在命令参数前后；托管 CLI 可由 fix/update 安装维护。"},
      {heading: "命令别名：", body: "<code>{prefix}st</code> 与 <code>{prefix}speedtest</code> 使用同一套参数。"}],
    async handle(i, context) {
      const {args, system} = argumentsOf(i);
      // Leading transport flags precede the declared command path in existing syntax.
      if ((i.args[0] === "--system" || i.args[0] === "-s") && resolveSubcommandName(command, args[0]) !== undefined) {
        await dispatchCommand(command, runDefault, {...i, args: [...args, ...(system ? ["--system"] : [])]}, context);
        return;
      }
      await runDefault(i, context);
    },
  };
  const help = (prefix: string) => renderCommandHelp("speedtest", command, {prefix, title: "⚡ Speedtest 使用方法"});

  return definePlugin({renderHelp: help,
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "speedtest",
    description: "使用官方 Ookla CLI 的网络测速工具",
    resources: {processes: {concurrency: 1, queueCapacity: 3, timeoutMs: 180_000, maxOutputBytes: 2 * 1024 * 1024}},
    commands: {speedtest: command, st: command},
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
