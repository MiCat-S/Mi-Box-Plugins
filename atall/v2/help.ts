import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📢 <b>AtAll</b>

📝 <b>功能描述:</b>
• 一键@群组中的所有成员
• 自动处理无用户名用户
• 智能消息分割

🔧 <b>使用方法:</b>
• <code>${p}atall</code> - @群组中的所有成员

⚠️ <b>注意事项:</b>
• 极大封号风险，后果自负
• 大群组中可能会生成很多条消息
• 一般来说你可以通过置顶消息来提醒所有人的`;
}
