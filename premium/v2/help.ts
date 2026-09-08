import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🎁 群组大会员统计插件

<b>命令格式：</b>
<code>${p}premium</code> - 统计群组大会员情况
<code>${p}premium force</code> - 强制统计（超过1万人时使用）

<b>功能：</b>
• 统计群组中的Telegram Premium会员情况
• 显示大会员比例
• 自动过滤机器人和死号`;
}
