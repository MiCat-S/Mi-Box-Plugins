import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `<b>📚 DeepWiki 插件</b>

DeepWiki通过与Github上的项目建立索引可以解决目前普遍的Ai信息滞后问题来精准回答您的提问

<b>🗂️ 项目管理</b>
• <code>${p}deepwiki add &lt;tag&gt; &lt;url&gt;</code>（添加新的项目）
• <code>${p}deepwiki lst</code>（已添加的项目）
• <code>${p}deepwiki use &lt;tag&gt;</code>（切换默认项目）
• <code>${p}deepwiki del &lt;tag&gt;</code>（删除指定项目）

<b>📜 上下文管理</b>
• <code>${p}deepwiki ctx</code>（上下文状态）
• <code>${p}deepwiki ctx on/off</code>（开启或关闭上下文）
• <code>${p}deepwiki ctx del</code>（清空当前项目上下文）
• <code>${p}deepwiki ctx del &lt;tag&gt;</code>（清空指定项目上下文）
• <code>${p}deepwiki ctx del all</code>（清空全部项目上下文）

<b>📌 使用说明</b>
• <code>${p}deepwiki 你的问题</code>（发起默认项目提问）
• <code>${p}deepwiki &lt;tag&gt; 你的问题</code>（发起指定项目提问）

说明：项目需要能在 deepwiki.com 上正常访问（已索引）。`;
}
