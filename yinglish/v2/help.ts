import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `💋 <b>淫语翻译</b>

<b>命令</b>
• <code>${p}yinglish [文本]</code>（也可回复一条消息使用）

<b>功能</b>
• 将中文/英文智能分词并随机替换为“淫语”风格文本
• 支持回复消息直接转换

<b>示例</b>
• <code>${p}yinglish 你好世界</code>
• 回复一条消息后发送 <code>${p}yinglish</code>`;
}
