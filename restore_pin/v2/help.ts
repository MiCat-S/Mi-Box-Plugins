import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📌 <b>恢复置顶插件</b>

<b>功能：</b>自动恢复管理员误取消的置顶消息

<b>命令：</b>
• <code>${p}restore_pin</code> - 自动恢复所有可恢复的置顶消息

<b>使用说明：</b>
1. 仅在群组中可用
2. 需要管理员权限
3. 自动扫描并恢复最近取消的置顶消息`;
}
