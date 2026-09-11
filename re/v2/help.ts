import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🔁 <b>消息复读</b>

回复一条消息，将包含该消息在内的最近若干条消息发送到当前会话。

<b>使用方法：</b>
• 回复消息发送 <code>${p}re</code> - 复读一条，一次
• <code>${p}re 3</code> - 复读截至被回复消息的 3 条消息
• <code>${p}re 3 2</code> - 将这 3 条消息复读 2 次

<b>参数：</b>
• 消息数默认 1，最多 20
• 复读次数默认 1，最多 10
• 来源禁止转发时自动复制文字、媒体及文字格式
• 在论坛话题中复读时仍发送到当前话题`;
}
