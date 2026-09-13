import {ui} from "telebox/sdk";

export function renderHelp(prefix: string, maxMentions: number, maxPages: number,
  maxMentionsPerPage: number, maxPageChars: number): string {
  const p = ui.text(prefix);
  return `📢 <b>AtAll</b>

📝 <b>功能描述:</b>
• 一键@群组中的可见普通成员、管理员和账号本人
• 自动跳过 Bot、已删除账号和无可用名称的成员
• 每次最多 ${maxMentions} 人、${maxPages} 条消息

🔧 <b>使用方法:</b>
• <code>${p}atall</code> - @群组中的所有成员

📦 <b>执行限制:</b>
• 每页最多 ${maxMentionsPerPage} 个 mention、${maxPageChars} 字符
• 同一时间只执行一个 AtAll 任务
• 达到上限时停止并在末页提示截断

⚠️ <b>注意事项:</b>
• 极大封号风险，后果自负
• 一般来说你可以通过置顶消息来提醒所有人的`;
}
