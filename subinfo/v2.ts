import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin, type PluginContext} from "telebox/sdk";
import {load, JSON_SCHEMA} from "js-yaml";
import {fetchSubscription, trafficSummary} from "./v2/fetch";
export {trafficSummary};

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
const protocols = ["vmess", "vless", "trojan", "ss", "ssr", "hysteria2", "hy2", "tuic", "socks", "socks5", "hysteria", "hy", "wireguard", "http", "https", "shadowtls", "naive"];
const regions: [string, string[]][] = [["香港", ["香港", "hong kong", "hk"]], ["台湾", ["台湾", "taiwan", "tw"]], ["日本", ["日本", "japan", "jp", "tokyo"]], ["新加坡", ["新加坡", "singapore", "sg"]], ["美国", ["美国", "united states", "usa", "us"]], ["英国", ["英国", "united kingdom", "uk", "london"]], ["德国", ["德国", "germany", "de"]], ["韩国", ["韩国", "korea", "kr"]], ["加拿大", ["加拿大", "canada", "ca"]], ["澳大利亚", ["澳大利亚", "australia", "au"]]];
function nodeName(line: string, type: string, index: number): string {
  const hash = line.indexOf("#");
  if (hash >= 0 && line.slice(hash + 1)) {
    try {return decodeURIComponent(line.slice(hash + 1));} catch {return line.slice(hash + 1);}
  }
  if (type === "vmess") {
    try {
      const data: unknown = JSON.parse(Buffer.from(line.slice(line.indexOf("://") + 3), "base64url").toString("utf8"));
      if (data && typeof data === "object" && "ps" in data && typeof data.ps === "string" && data.ps.trim()) return data.ps;
    } catch { /* Invalid node metadata does not invalidate other subscription entries. */ }
  }
  if (type === "ssr") {
    const decoded = Buffer.from(line.slice(line.indexOf("://") + 3), "base64url").toString("utf8");
    const query = decoded.indexOf("/?");
    if (query >= 0) {
      const remarks = new URLSearchParams(decoded.slice(query + 2)).get("remarks");
      if (remarks) {
        const name = Buffer.from(remarks, "base64url").toString("utf8");
        if (name.trim()) return name;
      }
    }
  }
  return `${type.toUpperCase()} ${index + 1}`;
}
function parse(raw: string) {
  let text = raw.trim();
  if (!text) throw new Error("订阅内容为空");
  try {
    const decoded = Buffer.from(text.replace(/\s/g, ""), "base64").toString("utf8");
    if (decoded.includes("://")) text = decoded;
  } catch {}
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const counts: Record<string, number> = Object.create(null);
  const names: string[] = [];
  const regionCounts: Record<string, number> = {};
  const nodes: {type: string; name: string}[] = [];
  if (/^(?:proxies\s*:|\{)/m.test(text)) {
    const config: unknown = load(text, {schema: JSON_SCHEMA});
    if (!config || typeof config !== "object" || !("proxies" in config) || !Array.isArray(config.proxies)) throw new Error("无效的 Clash 节点列表");
    for (const proxy of config.proxies) {
      if (!proxy || typeof proxy !== "object" || typeof proxy.type !== "string" || !proxy.type.trim()) throw new Error("无效的 Clash 节点");
      const type = proxy.type.toLowerCase();
      // Only display names and protocol labels, never serialize credential-bearing node objects.
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(type)) throw new Error("无效的 Clash 协议");
      nodes.push({type, name: typeof proxy.name === "string" && proxy.name.trim() ? proxy.name : `${type.toUpperCase()} ${nodes.length + 1}`});
    }
  } else {
    for (const line of lines) {
      const type = protocols.find(p => line.toLowerCase().startsWith(`${p}://`));
      if (type) nodes.push({type, name: nodeName(line, type, nodes.length)});
    }
  }
  for (const {type, name} of nodes) {
    counts[type] = (counts[type] ?? 0) + 1;
    names.push(name);
    const lower = name.toLowerCase();
    const found = regions.find(([, keys]) => keys.some(key => /^[a-z]+$/.test(key)
      ? new RegExp(`(?:^|[^a-z])${key}(?:$|[^a-z])`).test(lower) : lower.includes(key)));
    if (found) regionCounts[found[0]] = (regionCounts[found[0]] ?? 0) + 1;
  }
  if (nodes.length - Object.values(regionCounts).reduce((a, b) => a + b, 0) > 0) regionCounts["其他"] = nodes.length - Object.values(regionCounts).reduce((a, b) => a + b, 0);
  return {total: nodes.length, counts, names, regionCounts};
}
export default function createSubinfo() {
  const command: CommandDefinition = {"args":"[订阅链接]","examples":[{"args":"https://example.com/subscribe"},{"args":"","description":"回复包含 HTTP/HTTPS 订阅链接的消息"}],"help":[{"heading":"支持内容：","body":"Clash YAML/JSON 的 proxies 列表、明文或 Base64 编码的节点链接列表；支持 VMess、VLESS、Trojan、SS、SSR、Hysteria、TUIC、WireGuard 等协议。"},{"heading":"输出说明：","body":"显示节点数量、协议类型、地区分布、流量与到期信息，长列表自动分段。流量和到期取决于服务端订阅响应头；地区按节点名称识别，未识别的节点归入“其他”。"}],helpArgs: ["help","h"], description: "查看订阅基础信息", async handle(invocation, ctx: PluginContext) {
      let url = invocation.args[0];
      if (!url) {
        const reply = await ctx.telegram.getReply(invocation.message);
        url = reply?.text?.match(/https?:\/\/[^\s"'<>]+/i)?.[0] ?? "";
      }
      if (!url || url === "help" || url === "h") { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode:"html"}); return; }
      if (!/^https?:\/\/[^\s"'<>]{1,2048}$/i.test(url)) { await ctx.telegram.edit(invocation.message, "请输入有效的 HTTP(S) 订阅链接"); return; }
      try {
        await ctx.telegram.edit(invocation.message, "正在读取订阅…");
        const subscription = await fetchSubscription(ctx, url);
        const result = parse(subscription.text);
        const types = Object.entries(result.counts).map(([name, count]) => `${name}: ${count}`).join("\n") || "未识别常见节点协议";
        const regionText = Object.entries(result.regionCounts).map(([name, count]) => `${name}: ${count}`).join(" · ");
        const summary = `<b>订阅信息</b>\n节点总数: ${result.total}\n\n<b>流量与到期</b>\n${esc(subscription.traffic)}\n\n<b>协议分布</b>\n<pre>${esc(types)}</pre>${regionText ? `\n<b>地区分布</b>\n${esc(regionText)}` : ""}`;
        const pages: string[] = [];
        let page = summary + (result.names.length ? "\n\n<b>节点列表</b>\n<pre>" : "");
        for (const character of result.names.map((name, i) => `${i + 1}. ${name}`).join("\n")) {
          const escaped = esc(character);
          if (page.length + escaped.length + 6 > 3500) {
            pages.push(page + "</pre>");
            page = "<b>节点列表（续）</b>\n<pre>";
          }
          page += escaped;
        }
        pages.push(page + (result.names.length ? "</pre>" : ""));
        for (const [index, text] of pages.entries()) {
          ctx.signal.throwIfAborted();
          if (index === 0) await ctx.telegram.edit(invocation.message, text, {parseMode:"html"});
          else await ctx.telegram.reply(invocation.message, text, {parseMode:"html"});
        }
      } catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "订阅读取或解析失败，请稍后重试"); }
    }};
  const help = (prefix: string) => renderCommandHelp("subinfo", command, {prefix, title: "📈 订阅链接信息查询"});
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "subinfo", description: "查看订阅基础信息", commands: {
    subinfo: command,
  }});
}
