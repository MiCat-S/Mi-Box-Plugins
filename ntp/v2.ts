import {definePlugin, type PluginContext} from "telebox/sdk";

const HOST = "time.cloudflare.com";
const HELP = "<b>NTP 对时</b>\n<code>ntp</code> 查看时间偏差\n<code>ntp s</code> 尝试设置系统时间（需要系统权限）";
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

export default function createNtp() {
  return definePlugin({apiVersion: 1, id: "ntp", description: "查询网络时间偏差并尝试校准系统时间",
    resources: {processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 5000, maxOutputBytes: 64 * 1024}},
    commands: {ntp: {description: "查询或校准系统时间", async handle(invocation, ctx) {
      const mode = (invocation.args[0] ?? "").toLowerCase();
      if (mode && mode !== "s") { await ctx.telegram.edit(invocation.message, HELP, {parseMode: "html"}); return; }
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
    }}},
  });
}
