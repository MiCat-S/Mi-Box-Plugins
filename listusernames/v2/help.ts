import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📋 <b>listusernames - 列出公开群组/频道</b>

<b>命令格式：</b>
<code>${p}listusernames</code>

<b>功能说明：</b>
• 列出所有属于自己的公开群组/频道
• 所有用户均可使用

<b>使用示例：</b>
<code>${p}listusernames</code>`;
}
