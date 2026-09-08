import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🗃️ <b>Leech 归档状态</b>

查看当前账号会话状态与本地归档数据库统计。

<b>使用方法：</b>
• <code>${p}leech session</code> - 检查当前 Telegram 会话
• <code>${p}leech stats</code> - 列出归档数据库中的数据表与行数
• <code>${p}leech db</code> - 查看数据库信息

<b>功能范围：</b>
当前版本提供归档状态查询；历史消息抓取及任务管理尚未实现。`;
}
