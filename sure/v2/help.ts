import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📨 <b>代发消息白名单</b>

设置允许触发代发的用户、对话和消息规则。只有账号本人可以管理配置。

<b>用户与对话：</b>
• <code>${p}sure user add 用户ID</code> - 添加允许的用户
• <code>${p}sure user del 用户ID</code> - 删除用户
• <code>${p}sure chat add 对话ID</code> - 添加允许的对话
• <code>${p}sure chat del 对话ID</code> - 删除对话

<b>消息规则：</b>
• <code>${p}sure msg add 文本</code> - 添加单个文本的同文代发规则
• <code>${p}sure list</code> 或 <code>${p}sure ls</code> - 查看用户、对话及消息规则数量

<b>匹配方式：</b>
• 来自白名单用户的消息才会匹配
• 配置了对话白名单时，仅匹配这些对话
• 文本规则按整条消息精确匹配`;
}
