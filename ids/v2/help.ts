import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `用户信息查询插件

🆔 <b>用户信息查询插件</b>

<b>使用方式：</b>
• <code>${p}ids</code> - 显示自己的信息
• <code>${p}ids @用户名</code> - 查询指定用户信息
• <code>${p}ids 用户ID</code> - 通过ID查询用户信息
• 回复消息后使用 <code>${p}ids</code> - 查询被回复用户信息

<b>显示信息包括：</b>
• 用户名和显示名称
• 用户ID、注册时间估算、DC
• <b>入群时间</b>（仅群组有效）
• 共同群组数量
• 用户简介
• 三种跳转链接

<b>支持格式：</b>
• @用户名、用户ID、频道ID、回复消息`;
}
