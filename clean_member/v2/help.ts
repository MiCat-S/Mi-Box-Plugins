import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `<b>🧹 群成员清理工具 Pro</b>

<b>🔧 使用格式:</b>
<code>${p}clean_member ＜模式＞ ＜参数＞ [chat:-100xxx] [limit:数量] [search]</code>

<b>📋 清理模式:</b>
┌─────────────────────────
│ <b>1</b> ＜天数＞ → 未上线超过N天
│ <b>2</b> ＜天数＞ → 未发言超过N天
│ <b>3</b> ＜数量＞ → 发言少于N条
│ <b>4</b> → 已注销账户
│ <b>5</b> → 所有普通成员 ⚠️
└─────────────────────────

<b>⚙️ 可选参数:</b>
• <code>chat:-100xxx</code> - 指定群组ID(跨群查询)
• <code>limit:100</code> - 限制最多移出100人
• <code>search</code> - 仅搜索不移出（预览模式）

<b>💡 使用示例:</b>
• <code>${p}clean_member 1 30 search</code>
  └ 搜索30天未上线的用户（预览）
• <code>${p}clean_member 2 60 limit:50</code>
  └ 移出60天未发言，最多50人
• <code>${p}clean_member 4 chat:-1001234567890</code>
  └ 移出指定群组的注销账户
• <code>${p}clean_member 1 7 limit:10</code>
  └ 移出7天未上线，最多10人`;
}
