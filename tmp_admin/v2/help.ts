import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `⏳ <b>临时管理员</b>

为用户设置“临时管理”头衔和无实际管理能力的管理员席位，到期自动解除。

<b>命令：</b>
• 回复用户消息后发送 <code>${p}tmp_admin add [分钟]</code>
• <code>${p}tmp_admin add 用户ID或用户名 [分钟]</code> — 设置或续期
• 回复用户消息后发送 <code>${p}tmp_admin rm</code> — 提前解除
• <code>${p}tmp_admin rm 用户ID或用户名</code> — 解除指定用户
• <code>${p}tmp_admin list</code> — 查看当前对话等待自动解除的任务和剩余分钟
• add 的别名为 set；rm 的别名为 remove、del；list 的别名为 ls

<b>时长与权限：</b>
• 默认 30 分钟，可填写大于 0、最多 525600 的分钟数。
• 适用于超级群或频道，需要当前账号具备设置管理员的权限。
• 用户 ID 或用户名需能解析为用户；回复消息时以回复目标为准。
• 群主和已有实际管理权限的管理员不能改成临时管理员。

<b>示例：</b>
<code>${p}tmp_admin add @username 60</code>
<code>${p}tmp_admin list</code>
<code>${p}tmp_admin rm @username</code>
回复用户消息后发送 <code>${p}tmp_admin add 15</code>，设置 15 分钟临时席位。

<b>到期行为：</b>
• 任务持久保存，插件重新加载后恢复到期处理；停机期间到期的任务在恢复后处理。
• 到期时核对目标仍是插件设置的临时管理状态；若权限或头衔已变化，会保留当前管理员状态并通知。
• 解除失败时约 1 分钟后重试一次，仍失败会给出提示，需要检查目标状态和权限。
• 插件设置中的“启用”控制命令入口；关闭入口后，已有到期任务继续执行。

<b>常见提示：</b>
• 目标已经是管理员：请选择普通成员。
• 无法识别目标：回复目标用户的消息后重试。
• 当前已关闭：在插件设置中启用命令入口。

<code>${p}tmp_admin</code>、<code>${p}tmp_admin help</code> 或 <code>${p}help tmp_admin</code> 查看本说明。`;
}
