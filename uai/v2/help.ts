import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `⚙️ <b>UAI - 用户消息AI分析</b>

<b>📝 功能描述:</b>
• 引用用户消息，AI自动收集并分析/总结目标用户的历史消息
• 支持折叠显示AI回答，保持格式完整

<b>🔧 核心功能:</b>
• <code>${p}uai zj</code> - 总结（当天消息）
• <code>${p}uai fx</code> - 分析（当天消息）
• <code>${p}uai zj 50</code> - 总结最近50条
• <code>${p}uai fx 2h</code> - 分析最近2小时
• <code>${p}uai 自定义名</code> - 使用自定义提示词

<b>⚙️ 折叠显示:</b>
• <code>${p}uai collapse on/off</code> - 开启或关闭 AI 回答折叠

<b>🔌 供应商配置:</b>
• <code>${p}uai add &lt;名称&gt; &lt;url&gt; &lt;key&gt; &lt;type&gt;</code> - 添加供应商
• <code>${p}uai set &lt;名称&gt;</code> - 设置默认供应商
• <code>${p}uai del &lt;名称&gt;</code> - 删除供应商
• <code>${p}uai list</code> - 列出所有供应商
• <code>${p}uai model &lt;名称&gt; &lt;模型&gt;</code> - 修改模型

<b>📝 提示词配置:</b>
• <code>${p}uai prompt add &lt;名称&gt; &lt;内容&gt;</code> - 添加自定义提示词
• <code>${p}uai prompt del &lt;名称&gt;</code> - 删除自定义提示词
• <code>${p}uai prompt list</code> - 列出所有提示词

<b>💡 内置提示词:</b>
• <code>zj</code> - 总结（提取关键信息）
• <code>fx</code> - 分析（观点、态度分析）

<b>📋 参数说明:</b>
• type: openai / gemini
• 时间格式: 2h(2小时), 30m(30分钟)
• 数量格式: 50(最近50条)

<b>🔍 使用示例:</b>
1. 引用用户消息，回复: <code>${p}uai zj</code> - 总结当天消息
2. 引用用户消息，回复: <code>${p}uai fx 100</code> - 分析最近100条
3. 引用频道消息，回复: <code>${p}uai zj</code> - 总结频道消息

<b>密钥配置：</b>
涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。`;
}
