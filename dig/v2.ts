import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext} from "telebox/sdk";
import {isIP} from "node:net";
import {annotateLocations} from "./v2/location";

const types = new Set(["A", "AAAA", "MX", "CNAME", "TXT", "NS", "SOA", "PTR", "SRV", "CAA"]);
const help = (prefix: string) => `<b>DNS 查询</b>\n<code>${escape(prefix)}dig example.com</code>\n<code>${escape(prefix)}dig example.com MX @1.1.1.1</code>\n<code>${escape(prefix)}dig example.com MX +noall +answer</code>\n支持 A、AAAA、MX、CNAME、TXT、NS、SOA、PTR、SRV、CAA。\n选项：<code>+short +noall +answer +stats +comments +tcp</code>`;
const escape = (value: string) => value.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"})[c]!);

function args(input: readonly string[]): string[] {
  const flags = input.filter(value => value.startsWith("+"));
  if (flags.some(value => !["+short", "+noall", "+answer", "+stats", "+comments", "+tcp"].includes(value))) throw new Error("查询选项不支持");
  input = input.filter(value => !value.startsWith("+"));
  const servers = input.filter(value => value.startsWith("@"));
  if (servers.length > 1) throw new Error("只能指定一个 DNS 服务器");
  input = input.filter(value => !value.startsWith("@"));
  if (servers.length && input.length > 2) throw new Error("参数过多");
  if (input.length > 3) throw new Error("参数过多");
  const domain = input[0] ?? "";
  if (!/^(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\.)+[A-Za-z]{2,}\.?$/.test(domain) || domain.length > 253) {
    throw new Error("域名格式无效");
  }
  const type = (input[1] ?? "A").toUpperCase();
  if (!types.has(type)) throw new Error("记录类型不支持");
  const server = servers.length ? servers[0].slice(1) : input[2] ?? "";
  if (servers.length && !server) throw new Error("DNS 服务器格式无效");
  if (server && !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}\.?$/.test(server) && !isIP(server)) {
    throw new Error("DNS 服务器格式无效");
  }
  return [domain, type, server ? `@${server}` : "", ...(flags.length ? flags : ["+short"])];
}

function format(output: string, domain: string, type: string): string[] {
  if (!output.trim()) return [`<b>DNS 查询</b>\n<code>${escape(domain)}</code>\n\n无记录`];
  const heading = `<b>DNS 查询结果</b>\n<code>${escape(domain)}</code> · <code>${type}</code>\n\n`;
  const pages: string[] = [];
  let page = "";
  for (const char of output.trim()) {
    const escaped = escape(char);
    if (heading.length + page.length + escaped.length + 11 > 3500) {
      pages.push(`${heading}<pre>${page}</pre>`); page = "";
    }
    page += escaped;
  }
  if (page) pages.push(`${heading}<pre>${page}</pre>`);
  return pages;
}

async function runDig(ctx: PluginContext, values: string[]): Promise<string> {
  const command = [...(values[2] ? [values[2]] : []), values[0], values[1], ...values.slice(3)];
  const result = await ctx.processes.run("/usr/bin/dig", command, {timeoutMs: 10_000, maxOutputBytes: 32_768});
  return result.stdout.toString("utf8");
}

export default function createDig() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "dig", description: "查询 DNS 记录",
    commands: {dig: {helpArgs: ["help","h"], helpOnEmpty: true, description: "查询 DNS 记录", async handle(invocation, ctx) {
      const raw = invocation.args;
      if (!raw.length || raw[0] === "help" || raw[0] === "h") {
        await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return;
      }
      try {
        ctx.signal.throwIfAborted();
        const values = args(raw);
        await ctx.telegram.edit(invocation.message, "正在查询 DNS…");
        ctx.signal.throwIfAborted();
        const output = await runDig(ctx, values);
        const pages = format(await annotateLocations(ctx, output), values[0], values[1]);
        for (const [index, page] of pages.entries()) {
          ctx.signal.throwIfAborted();
          if (index === 0) await ctx.telegram.edit(invocation.message, page, {parseMode: "html"});
          else await ctx.telegram.reply(invocation.message, page, {parseMode: "html"});
        }
      } catch (error) {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `<b>DNS 查询失败</b>\n${escape(error instanceof Error ? error.message : "请稍后重试")}`, {parseMode: "html"});
      }
    }}},
  });
}
