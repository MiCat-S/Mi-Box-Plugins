import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🔁 <b>消息复读</b>

回复一条消息，将包含该消息在内的最近若干条消息转发到当前会话。

<b>使用方法：</b>
• 回复消息发送 <code>${p}re</code> - 转发一条，一次
• <code>${p}re 3</code> - 转发截至被回复消息的 3 条消息
• <code>${p}re 3 2</code> - 将这 3 条消息重复转发 2 次

<b>参数：</b>
• 消息数默认 1，最多 20
• 复读次数默认 1，最多 10
• 目标消息需要允许转发`;
}
