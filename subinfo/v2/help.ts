import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📈 <b>订阅链接信息查询</b>

查询订阅的节点数量、协议类型、地区分布、流量与到期信息。

<b>使用方法：</b>
• <code>${p}subinfo 订阅链接</code> - 查询一个 HTTP/HTTPS 订阅
• 回复包含订阅链接的消息后发送 <code>${p}subinfo</code>

<b>支持内容：</b>
• Clash YAML/JSON 的 <code>proxies</code> 列表
• 明文或 Base64 编码的节点链接列表
• VMess、VLESS、Trojan、SS、SSR、Hysteria、TUIC、WireGuard 等协议
• 流量和到期信息取决于服务端返回的订阅响应头
• 地区按节点名称识别，未识别的节点归入“其他”

<b>示例：</b>
<code>${p}subinfo https://example.com/subscribe</code>`;
}
