import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `IP 查询插件：
- ${p}ip &lt;IP地址/域名&gt; - 查询 IP 地址或域名的详细信息
- 也可回复包含 IP/域名 的消息后使用 ip 命令

示例：
1. ip 8.8.8.8
2. ip google.com
3. 回复包含 IP 的消息后使用 ip`;
}
