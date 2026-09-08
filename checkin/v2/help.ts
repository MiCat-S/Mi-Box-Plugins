import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `<b>🤖 CheckIn 自动化签到插件</b>

<b>📌 基础指令：</b>
<code>${p}checkin</code> - 手动触发所有签到
<code>${p}checkin reset</code> - 重置今日运行状态
<code>${p}checkin help</code> - 显示此帮助

<b>🎯 目标管理：</b>
<code>${p}checkin add [ID] [名称] [目标] [data:回调|text:按钮]</code> — 添加后<b>回复提示消息</b>发签到命令
<code>${p}checkin del [ID]</code>
<code>${p}checkin list</code>
<code>${p}checkin toggle [ID]</code>
<code>${p}checkin test [ID]</code>

<b>⚙️ 配置管理：</b>
<code>${p}checkin set time [HH:MM]</code> - 设置开始时间
<code>${p}checkin set range [HH:MM]</code> - 设置执行时间结束点（留空则改为固定时间）
<code>${p}checkin set delay [分钟]</code> - 设置额外随机延迟（0-60 分钟）
<code>${p}checkin set bot [Token] [ChatID]</code> - 设置 Bot 通知
<code>${p}checkin set log [ChatID]</code> - 设置日志聊天
<code>${p}checkin settings</code> - 查看当前配置

<b>💡 使用示例：</b>
<code>${p}checkin add storm Storm签到 @storm_bot data:checkin</code>
→ 然后回复提示消息：<code>/sign 123456</code>（命令可含空格）
<code>${p}checkin set time 10:00</code> - 从 10:00 开始
<code>${p}checkin set range 11:30</code> - 在 10:00 到 11:30 之间随机执行
<code>${p}checkin set range</code> - 清除时间范围，改为固定时间执行

<b>🔄 时间范围说明：</b>
设置 range 后，系统会每天在 time 到 range 之间随机选择一个时刻执行，
这样可以避免每天都在同一时间签到。支持跨天，例如 22:00 到次日 02:00。

<b>密钥配置：</b>
涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。`;
}
