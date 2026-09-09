import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📘 <b>AI 翻译</b>

• <code>${p}gt [文本]</code> - 翻译为简体中文
• <code>${p}gt en [文本]</code> - 翻译为英文
• 回复消息后使用 <code>${p}gt</code> 或 <code>${p}gt en</code>
• <code>${p}gt help</code> - 查看帮助

使用 ai 插件当前聊天 API、模型及超时设置。
请先安装配套 ai 插件，并通过 <code>${p}ai config add</code> 和 <code>${p}ai model chat</code> 配置。
待翻译文本会发送至该 API，可能产生模型调用费用。
单次最多 5000 字符，长译文自动分段发送。`;
}
