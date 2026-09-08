import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `⏰ <b>定时发送消息插件</b>

<b>使用方法：</b>
<code>${p}sendat 时间 | 消息内容</code> - 添加定时任务
<code>${p}sendat list</code> - 查看我的任务
<code>${p}sendat list all</code> - 查看所有任务（管理员）
<code>${p}sendat rm 任务ID</code> - 删除任务
<code>${p}sendat pause 任务ID</code> - 暂停任务
<code>${p}sendat resume 任务ID</code> - 恢复任务

<b>时间格式示例：</b>
• <code>${p}sendat 16:00:00 date | 投票截止！</code> - 到下一个16:00发送一次
• <code>${p}sendat every 23:59:59 date | 又是无所事事的一天呢。</code> - 每天23:59:59发送
• <code>${p}sendat every 1 minutes | 又过去了一分钟。</code> - 每分钟发送
• <code>${p}sendat 3 times 1 minutes | 此消息将出现三次。</code> - 每分钟发送，共3次

<b>支持的时间单位：</b>
seconds, minutes, hours, date, times

<b>时区：</b>
默认时区为 <code>Asia/Shanghai</code>，可在插件设置中修改 IANA 时区。`;
}
