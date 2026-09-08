import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `临时管理员


使用 <code>${p}tmp_admin add [分钟]</code> 回复一条消息, <code>${p}tmp_admin add 用户ID/用户名 [分钟]</code> 设置无权限临时管理员, 默认 30 分钟
使用 <code>${p}tmp_admin rm/remove</code> 回复一条消息, <code>${p}tmp_admin rm/remove 用户ID/用户名</code> 提前解除临时管理员
<code>${p}tmp_admin ls/list</code> 查看当前对话等待自动解除的临时管理员`;
}
