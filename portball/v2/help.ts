import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🔇 <b>Portball 临时禁言工具</b>

<b>用法：</b>
<code>${p}portball [理由] 时间</code>

<b>时间单位：</b>
• s - 秒 (默认)
• m - 分钟
• h - 小时
• d - 天

<b>示例：</b>
• <code>${p}portball 广告 5m</code> - 禁言5分钟
• <code>${p}portball 10m</code> - 禁言10分钟
• <code>${p}portball 刷屏 1h</code> - 禁言1小时
• <code>${p}portball 300</code> - 禁言300秒

<b>注意：</b>
• 需要回复目标用户的消息
• 禁言时间必须 ≥ 60秒
• 需要管理员权限`;
}
