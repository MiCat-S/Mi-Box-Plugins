import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🧹 <b>群成员搜索与清理</b>

按活跃度、发言数量或账号状态搜索成员，生成报告，或执行移出操作。

<b>格式：</b>
<code>${p}clean_member 模式 [参数] [chat:群组ID] [limit:数量] [search]</code>

<b>模式：</b>
• 1 天数 — 最后上线超过指定天数；最后上线未知时跳过
• 2 天数 — 指定时间段内没有发言
• 3 数量 — 可查询历史中发言条数小于指定数量
• 4 — 已注销账号，无需额外参数
• 5 — 所有普通成员，无需额外参数
模式 1、2、3 的参数须为正整数；模式 1、2 输入小于 7 时自动调整为 7 天。

<b>可选参数：</b>
• <code>chat:-1001234567890</code> — 指定可访问的群组；省略时使用当前对话
• <code>limit:50</code> — 最多成功移出 50 人；该值控制移出人数，搜索仍按搜索范围执行
• <code>search</code> — 仅搜索并生成报告；省略时直接执行移出

<b>使用示例：</b>
1. <code>${p}clean_member 1 30 search</code> — 查看超过 30 天未上线的成员
2. <code>${p}clean_member 1 30 limit:10</code> — 按条件重新查询，最多移出 10 人
3. <code>${p}clean_member 4 chat:-1001234567890 search</code> — 搜索指定群的注销账号
4. <code>${p}clean_member 3 5 search</code> — 搜索发言少于 5 条的成员

<b>权限与数据范围：</b>
• 执行移出需要群主身份或封禁成员权限，搜索需要能够访问群组和相关数据。
• 查询会跳过识别到的管理员；上线状态与发言统计受 Telegram 可见数据限制。
• 移出后会立即解除封禁，用户仍可通过有效方式重新加入。
• 相同群组、模式和参数的搜索结果可复用 24 小时缓存；实际清理会重新查询。

<b>报告与常见提示：</b>
• CSV 报告保存在插件数据目录，完成回执显示文件路径；失败用户报告会尝试发送到收藏夹。
• 找到的人数可能大于实际移出人数，需结合 limit、失败和跳过统计查看。
• 权限不足或无法访问群组时，核对账号权限和 chat 参数。

<code>${p}clean_member</code>、<code>${p}clean_member help</code> 或 <code>${p}help clean_member</code> 查看本说明。`;
}
