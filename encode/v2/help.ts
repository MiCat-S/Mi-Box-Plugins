import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `编码解码工具插件

🔐 <b>编码解码工具集</b>

<b>可用命令：</b>
• <code>${p}b64encode</code> - Base64 编码
• <code>${p}b64decode</code> - Base64 解码
• <code>${p}urlencode</code> - URL 编码
• <code>${p}urldecode</code> - URL 解码

<b>使用示例：</b>
• <code>${p}b64encode Hello World</code>
• <code>${p}b64decode SGVsbG8gV29ybGQ=</code>
• <code>${p}urlencode 你好世界</code>
• <code>${p}urldecode %E4%BD%A0%E5%A5%BD%E4%B8%96%E7%95%8C</code>

<b>回复消息处理：</b>
支持回复消息后直接使用命令进行编码/解码

<b>命令别名：</b>
<code>${p}encode</code> - 查看编码解码工具帮助`;
}
