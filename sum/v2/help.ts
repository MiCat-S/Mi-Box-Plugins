import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `群消息总结插件

▎群消息总结

<b>⚡ 立即总结</b>
<code>${p}sum</code>
总结当前群最近 100 条消息。

<code>${p}sum 200</code>
总结当前群最近 200 条消息。

<code>${p}sum 100 --provider myai</code>
使用指定 AI 配置总结。

<b>🕒 定时总结</b>
<code>${p}sum add &lt;群组&gt; &lt;间隔&gt; [消息数]</code>
间隔示例：<code>2h</code>（每 2 小时）、<code>30m</code>（每 30 分钟）。

<b>🔎 查看当前配置</b>
<code>${p}sum config list</code>
显示所有 AI 配置、默认配置、模型、接口识别结果和链接预览状态。

<b>🤖 添加 AI 配置</b>
<code>${p}sum config add &lt;名称&gt; &lt;BaseURL&gt; &lt;API_KEY&gt; &lt;模型&gt;</code>
示例：
<code>${p}sum config add myai https://api.example.com sk-xxx gpt-5.6-terra</code>
模型接口会自动识别：GPT-5/o 系列走 Responses，Gemini 走 Gemini API，Claude 走 Anthropic Messages，其他模型走 Chat Completions。

<b>✏️ 修改 AI 配置</b>
下面三条命令分别修改模型、地址和 Key：
<code>${p}sum config set myai model gpt-5.6-terra</code>
<code>${p}sum config set myai url https://api.example.com</code>
<code>${p}sum config set myai key sk-xxx</code>

<b>🗑 删除 AI 配置</b>
<code>${p}sum config del myai</code>
删除配置。若删除的是默认配置，插件会自动清空默认项；使用该配置的定时任务将改为使用全局默认配置。

<b>⚙️ 全局设置</b>
<code>${p}sum config set default myai</code>
设为默认 AI 配置。

<code>${p}sum config set preview off</code>
关闭链接预览（默认关闭）；改为 <code>on</code> 可开启。

<code>${p}sum config set reasoning auto|none|minimal|low|medium|high|xhigh</code>
设置 OpenAI Chat Completions/Responses 接口的思考强度；<code>auto</code> 使用服务端默认值。

<code>${p}sum config set service auto|default|priority|fast|flex</code>
设置 OpenAI Chat Completions/Responses 接口的服务等级；<code>auto</code> 不发送该参数。

<code>${p}sum config set prompt &lt;提示词&gt;</code>
设置默认总结提示词；<code>${p}sum config set prompt reset</code> 恢复内置详细版。

<code>${p}sum config set prompt show</code>
查看当前实际生效的提示词。

<b>📋 任务管理</b>
<code>${p}sum list</code> - 查看任务
<code>${p}sum run &lt;ID&gt;</code> - 立即执行任务
<code>${p}sum del &lt;ID&gt;</code> - 删除任务
<code>${p}sum disable &lt;ID&gt;</code> - 暂停任务
<code>${p}sum enable &lt;ID&gt;</code> - 恢复任务

<b>接口与显示设置：</b>
• <code>${p}sum config add 名称 BaseURL API_KEY 模型 类型</code> - 可显式指定接口类型
• <code>${p}sum config set 名称 type auto|chat|responses|gemini|anthropic</code>
• <code>${p}sum config set spoiler on|off</code> - 设置回答折叠
• 即时总结消息数范围为 10–500；定时任务结果发送到收藏夹。

<b>密钥配置：</b>
涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。`;
}
