import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🧹 <b>清理群内贴纸消息</b>

<b>命令</b>
• <code>${p}clear_sticker [数量]</code> / <code>${p}cs [数量]</code>

<b>说明</b>
• 清理群内历史贴纸消息（仅群聊可用）
• 可选参数“数量”用于限制删除数量（默认清理全部）`;
}
