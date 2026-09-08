import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `智能防撤回删除插件

🗑️ <b>智能防撤回删除插件</b>

<b>命令格式：</b>
<code>${p}dme [数量]</code>
<code>${p}dme -f [数量]</code>

<b>可用命令：</b>
• <code>${p}dme [数量]</code> - 快速删除指定数量的消息
• <code>${p}dme -f [数量]</code> - 防撤回模式（替换媒体后删除）

<b>智能适配：</b>
• 自动检测禁止转发和复制的群组
• 受限群组自动切换传统遍历模式
• API搜索失败时自动回退处理

<b>示例：</b>
• <code>${p}dme 10</code> - 快速删除最近10条消息
• <code>${p}dme -f 100</code> - 防撤回删除最近100条消息
• <code>${p}dme 999</code> - 快速删除所有自己的消息`;
}
