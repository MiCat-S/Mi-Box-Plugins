import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🔧 <b>关键词回复插件 - 完整使用指南</b>

<b>📋 基础命令：</b>
<code>${p}keyword list</code> - 查看当前群组的关键词任务
<code>${p}keyword list all</code> - 查看所有群组的关键词任务
<code>${p}keyword rm 1,2,3</code> - 删除指定ID的任务
<code>${p}keyword alias</code> - 查看当前群组继承设置
<code>${p}keyword alias 123456</code> - 设置继承其他群组的关键词
<code>${p}keyword alias rm</code> - 删除继承设置

<b>📝 添加关键词任务格式：</b>
<code>${p}keyword 关键词内容
+++
回复消息内容
+++
匹配选项
+++
执行动作
+++
延迟删除秒数
+++
原消息延迟删除秒数</code>

<b>🎯 匹配选项（第3段，空格分隔）：</b>
• <code>include</code> - 包含匹配（默认）
• <code>exact</code> - 精确匹配
• <code>regexp</code> - 正则表达式匹配
• <code>case</code> - 区分大小写
• <code>ignore_forward</code> - 忽略转发消息

<b>⚡ 执行动作（第4段，空格分隔）：</b>
• <code>reply</code> - 回复消息（默认）
• <code>delete</code> - 删除触发消息
• <code>ban300</code> - 封禁用户300秒
• <code>restrict600</code> - 限制用户600秒

<b>🔤 消息变量：</b>
• <code>$mention</code> - @提及用户
• <code>$code_id</code> - 用户ID
• <code>$code_name</code> - 用户姓名
• <code>$delay_delete</code> - 延迟删除时间

<b>📖 使用示例：</b>

<b>1. 简单关键词回复：</b>
<code>${p}keyword 你好
+++
欢迎！$mention</code>

<b>2. 精确匹配+删除原消息：</b>
<code>${p}keyword 违规词汇
+++
⚠️ 请注意言辞！
+++
exact case
+++
reply delete</code>

<b>3. 正则表达式+延迟删除：</b>
<code>${p}keyword \\d{11}
+++
🚫 请勿发送手机号码
+++
regexp
+++
reply delete
+++
10
+++
0</code>

<b>4. 封禁用户：</b>
<code>${p}keyword 广告
+++
🚫 检测到广告，用户已被封禁
+++
include
+++
reply delete ban3600</code>

<b>💡 高级功能：</b>
• <b>继承机制：</b>可以让当前群组继承其他群组的关键词设置
• <b>延迟删除：</b>支持定时删除回复消息和原消息
• <b>批量管理：</b>支持批量删除多个任务
• <b>灵活匹配：</b>支持包含、精确、正则三种匹配模式

<b>⚠️ 注意事项：</b>
• 封禁和限制功能需要机器人有管理员权限
• 正则表达式需要转义特殊字符（如 \\\\d）
• 继承功能会同时检查当前群组和继承群组的关键词
• 任务ID在删除后不会重复使用

<b>🔗 更多信息：</b>
如需更多帮助，请参考 TeleBox 官方文档或联系管理员。`;
}
