import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📨 <b>代发消息白名单</b>

设置允许触发代发的用户、对话和消息规则。只有账号本人可以管理配置。

<b>用户与对话：</b>
• <code>${p}sure add 用户ID/@用户名</code> - 添加用户；省略目标时使用回复者
• <code>${p}sure del 用户ID/@用户名</code> - 删除用户
• <code>${p}sure ls</code> - 查看用户白名单
• <code>${p}sure chat add 对话ID/@名称</code> - 添加对话；省略目标时使用当前对话
• <code>${p}sure chat del 对话ID/@名称</code> - 删除对话
• <code>${p}sure chat ls</code> - 查看对话白名单

<b>消息规则：</b>
• <code>${p}sure msg add 文本</code> - 添加单个文本的同文代发规则
• <code>${p}sure msg redirect ID 文本</code> - 设置重定向；省略文本时清除
• <code>${p}sure msg del ID</code> - 删除规则
• <code>${p}sure msg ls</code> - 查看消息规则

<b>匹配方式：</b>
• 来自白名单用户的消息才会匹配
• 配置了对话白名单时，仅匹配这些对话
• 文本规则按整条消息精确匹配
• <code>_command:/sb</code> 可匹配 <code>/sb</code> 及其空格参数，并保留参数进行重定向`;
}
