import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `消息历史查询插件

📜 <b>消息历史查询</b>

<b>使用方法：</b>
• <code>${p}his</code> - 回复消息时查询该用户历史
• <code>${p}his &lt;目标&gt;</code> - 查询目标的消息历史
• <code>${p}his &lt;目标&gt; &lt;数量&gt;</code> - 查询指定数量消息
• <code>${p}his &lt;数量&gt;</code> - 回复消息时查询指定数量

<b>示例：</b>
• 回复消息后：<code>${p}his</code>
• <code>${p}his @username</code>
• <code>${p}his 123456789 10</code>
• 回复消息后：<code>${p}his 5</code>

<b>注意事项：</b>
• 仅限群组使用
• 默认查询30条消息
• 目标可以是用户名、用户ID或频道ID`;
}
