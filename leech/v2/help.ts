import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🗃️ <b>Leech 归档状态</b>

抓取 Telegram 聊天历史到本地 SQLite，并查看会话与归档状态。

<b>使用方法：</b>
• <code>${p}leech login</code> / <code>${p}leech session</code> - 检查当前 Telegram 会话
• <code>${p}leech chat here --from 2026-01-01 --to 2026-01-31</code> - 归档当前聊天
• <code>${p}leech chat @username --from 2026-01-01 --to 2026-01-31 --limit 500 --batch 100</code> - 归档指定聊天
• <code>${p}leech jobs [数量]</code> - 查看最近任务
• <code>${p}leech stats</code> - 列出归档数据库中的数据表与行数
• <code>${p}leech db</code> - 查看数据库信息

<b>功能范围：</b>
目标支持 @username、数字 ID、t.me 链接和 here；日期范围为必填项。仅保存消息元数据与文本，不下载媒体文件。`;
}
