import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🕒 <b>定时自动删除消息</b>

<b>命令</b>
• <code>${p}autodel [时间] [global]</code> 设置自动删除
• <code>${p}autodel l</code> 查看当前设置
• <code>${p}autodel cancel [global]</code> 取消设置

<b>时间格式</b>
• <code>30 seconds</code>、<code>5 minutes</code>、<code>2 hours</code>、<code>1 days</code>
• 简写：<code>30s</code>、<code>5m</code>、<code>2h</code>、<code>1d</code>
• 中文：<code>30秒</code>、<code>5分</code>/<code>5分钟</code>、<code>2小时</code>/<code>2时</code>、<code>1天</code>

<b>示例</b>
• <code>${p}autodel 30s</code>
• <code>${p}autodel 5 分钟 global</code>（设置全局）

<b>⚠️ 安全说明</b>
• 只会删除您自己发送的消息
• 最小删除时间为5秒`;
}
