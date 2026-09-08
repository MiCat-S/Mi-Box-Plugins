import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `管理管理员


使用 <code>${p}manage_admin add [头衔]</code> 回复一条消息, <code>${p}manage_admin add 用户ID/用户名 [头衔]</code> 提升用户为管理员(若之前不是)并设置/更新/清空头衔(可选), 权限默认只有 ban
使用 <code>${p}manage_admin rm/remove</code> 回复一条消息, <code>${p}manage_admin rm/remove 用户ID/用户名</code> 将用户移除管理员
<code>${p}manage_admin ls/list</code> 查看当前对话所有管理员`;
}
