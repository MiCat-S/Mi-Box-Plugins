import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `👮 <b>群组管理员管理</b>

添加或移除管理员，并设置管理员头衔。

<b>命令：</b>
• 回复用户消息后发送 <code>${p}manage_admin add [头衔]</code> — 设置管理员和头衔
• <code>${p}manage_admin add 用户ID或用户名 [头衔]</code> — 显式指定用户
• 回复用户消息后发送 <code>${p}manage_admin rm</code> — 移除该用户管理员身份
• <code>${p}manage_admin rm 用户ID或用户名</code> — 移除指定管理员
• <code>${p}manage_admin list</code> — 查看当前超级群或频道管理员，最多返回 200 人
• add 的别名为 set；rm 的别名为 remove、del；list 的别名为 ls

<b>权限与头衔：</b>
• 操作在当前群组或频道执行。超级群和频道需要群主身份或“添加管理员”权限。
• 在超级群和频道，add 会将目标的管理员权限设置为仅封禁用户，包括目标原本已经是管理员的情况。
• 头衔可包含空格，最多保留 16 个字符；省略头衔时清空头衔。
• 基本群使用 Telegram 的管理员开关，权限与头衔行为受群类型限制；列表功能仅支持超级群/频道。
• 回复消息时，以被回复消息的发送者为目标。

<b>示例：</b>
<code>${p}manage_admin add @username 值班管理员</code>
<code>${p}manage_admin list</code>
<code>${p}manage_admin rm @username</code>
回复某用户消息后，发送 <code>${p}manage_admin add 值班管理员</code> 也可设置。

<b>常见提示：</b>
• 权限不足：检查当前账号是否能添加管理员。
• 目标无效：优先回复该用户的消息，避免无法解析数字 ID；目标需为用户。
• 头衔未更新：根据回执检查群类型、群主权限及服务端同步状态。

<code>${p}manage_admin</code>、<code>${p}manage_admin help</code> 或 <code>${p}help manage_admin</code> 查看本说明。`;
}
