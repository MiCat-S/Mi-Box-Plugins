import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🌙 <b>早晚安统计插件</b>

自动回复早晚安并统计排名。默认关闭，需手动开启。

<b>指令:</b>
• <code>${p}goodnight on/off</code> - 开启或关闭统计
• <code>${p}goodnight utc+8</code> - 设置时区 (支持 utc+8, utc-5 格式)
• <code>${p}goodnight</code> - 查看状态

<b>命令别名：</b>
<code>${p}gn</code> 是 <code>${p}goodnight</code> 的别名，支持相同参数。`;
}
