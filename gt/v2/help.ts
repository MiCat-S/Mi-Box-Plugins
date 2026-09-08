import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📘 <b>Google 翻译</b>

• <code>${p}gt [文本]</code> - 翻译为简体中文
• <code>${p}gt en [文本]</code> - 翻译为英文
• 回复消息后使用 <code>${p}gt</code> 或 <code>${p}gt en</code>
• <code>${p}gt help</code> - 查看帮助

使用 Google 自动识别原文语言，无需配置 API Key。
待翻译文本会发送至 Google 翻译服务。
单次最多 5000 字符，长译文自动分段发送。`;
}
