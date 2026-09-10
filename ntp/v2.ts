import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, type CommandInvocation, definePlugin, type PluginContext} from "telebox/sdk";

const HOST = "time.cloudflare.com";
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]!);
const fmt = (ms: number) => `${ms >= 0 ? "+" : "-"}${Math.abs(ms) >= 1000 ? `${(Math.abs(ms) / 1000).toFixed(3)}s` : `${Math.abs(ms).toFixed(1)}ms`}`;
const dateCN = (ms: number) => new Date(ms).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai"});

async function query(ctx: PluginContext) {
  const started = Date.now();
  return ctx.http.withResponse(`https://${HOST}/`, {method: "HEAD", cache: "no-store"}, async response => {
    if (!response.ok) throw new Error("status");
    const raw = response.headers.get("date");
    const server = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(server)) throw new Error("date");
    const ended = Date.now();
    const delay = ended - started;
    return {delay, offset: server + delay / 2 - ended, serverTime: server + delay / 2};
  }, {timeoutMs: 5000, redirects: {allowedHosts: [HOST], maxRedirects: 1}});
}

async function execute(invocation: CommandInvocation, ctx: PluginContext, mode: "" | "s") {
      await ctx.telegram.edit(invocation.message, mode === "s" ? "🔧 正在获取网络时间…" : "⏳ 正在查询网络时间…");
      try {
        const result = await query(ctx);
        const header = `🕒 <b>时间查询完成</b>\n• 服务器: <code>${HOST}</code>\n• 往返延迟: <code>${fmt(result.delay)}</code>\n• 本地相对偏移: <code>${fmt(result.offset)}</code>\n• 本地时间: <code>${dateCN(Date.now())}</code>\n• 服务器时间(估算): <code>${dateCN(result.serverTime)}</code>`;
        if (mode !== "s") { await ctx.telegram.edit(invocation.message, header, {parseMode: "html"}); return; }
        const executable = process.platform === "linux" ? "/bin/date" : process.platform === "darwin" ? "/bin/date" : "";
        if (!executable) { await ctx.telegram.edit(invocation.message, `${header}\n• 当前平台不支持自动设置`, {parseMode: "html"}); return; }
        const args = process.platform === "linux" ? ["-u", "-s", `@${Math.floor(result.serverTime / 1000)}`] : ["-u", new Date(result.serverTime).toISOString().replace(/[-:T]/g, "").slice(4, 16)];
        try {
          await ctx.processes.run(executable, args, {timeoutMs: 5000, maxOutputBytes: 64 * 1024});
          await ctx.telegram.edit(invocation.message, `${header}\n• 系统时间已设置`, {parseMode: "html"});
        } catch {
          ctx.signal.throwIfAborted();
          await ctx.telegram.edit(invocation.message, `${header}\n• 未能设置系统时间，请确认服务运行权限`, {parseMode: "html"});
        }
      } catch (error) {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `❌ ${mode === "s" ? "对时" : "查询"}失败，请稍后重试`);
      }
}
const command: CommandDefinition = {
  description: "查询或校准系统时间", args: "", examples: [{args: ""}],
  subcommandsCaseSensitive: false,
  subcommands: {s: {description: "获取网络时间并尝试设置系统时间", args: "", examples: [{args: "s"}],
    help: [{heading: "权限：", body: "Linux/macOS 通过 /bin/date 设置系统时间，需要服务进程具有相应系统权限。"}],
    handle: (invocation, ctx) => execute(invocation, ctx, "s")}},
  help: [{heading: "时间来源：", body: "通过 time.cloudflare.com 的 HTTPS Date 响应头估算往返延迟和本地时间偏差；该接口的时间精度有限。显示本地及估算服务器时间；无参数仅查询。"}],
  async handle(invocation, ctx) {
    if (invocation.args.length) { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
    await execute(invocation, ctx, "");
  },
};
const help = (prefix: string) => renderCommandHelp("ntp", command, {prefix, title: "🕒 网络对时"});
export default function createNtp() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "ntp", description: "查询网络时间偏差并尝试校准系统时间", renderHelp: help,
    resources: {processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 5000, maxOutputBytes: 64 * 1024}}, commands: {ntp: command}});
}
