import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🌐 <b>DNS 查询</b>

<b>使用方法：</b>
• <code>${p}dig example.com</code> - 查询 A 记录
• <code>${p}dig example.com MX</code> - 指定记录类型
• <code>${p}dig example.com MX @1.1.1.1</code> - 指定 DNS 服务器
• <code>${p}dig example.com MX +noall +answer</code> - 指定输出选项

<b>参数：</b>
• 记录类型：A、AAAA、MX、CNAME、TXT、NS、SOA、PTR、SRV、CAA
• DNS 服务器可用 IP 或域名，放在第三个参数或使用 <code>@服务器</code>
• 输出选项：<code>+short +noall +answer +stats +comments +tcp</code>
• 默认使用 <code>+short</code>，查询结果附带 IP 归属地与 ASN 信息

<b>依赖：</b>
• 运行环境需要提供 <code>/usr/bin/dig</code>`;
}
