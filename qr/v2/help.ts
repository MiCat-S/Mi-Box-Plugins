import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📱 QR 二维码插件
支持二维码生成和解码功能。
使用前请先安装依赖。

━━━ 核心功能 ━━━
• <code>${p}qr &lt;文本&gt;</code> - 直接生成二维码
• 回复文本消息使用 <code>${p}qr</code> - 将消息内容转为二维码
• 回复图片使用 <code>${p}qr</code> - 解码图中的二维码内容

━━━ 功能特性 ━━━
• 📱 <b>生成二维码</b> - 将文本转换为二维码图片
• 🔍 <b>解码二维码</b> - 从图片中识别和解码二维码内容
• 💬 <b>多种使用方式</b> - 支持命令参数、回复消息等多种交互方式

━━━ 系统依赖 ━━━
<b>macOS:</b>
<code>brew install qrencode zbar</code>

<b>Ubuntu/Debian:</b>
<code>sudo apt-get install qrencode zbar-tools</code>

<b>CentOS/RHEL:</b>
<code>sudo yum install qrencode zbar</code>

━━━ 使用示例 ━━━
• 生成二维码: <code>${p}qr Hello World</code>
• 解码二维码: 回复包含二维码的图片并发送 <code>${p}qr</code>
• 文本转码: 回复文本消息并发送 <code>${p}qr</code>`;
}
