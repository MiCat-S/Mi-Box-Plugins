import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `生成头像融合动图

🧩 <b>头像动图表情</b>

<b>用法：</b>
<code>${p}eatgif [list|ls|clear|名称]</code>
• <b>空/ list</b>：查看表情列表
• <b>生成</b>：回复目标并输入名称`;
}
