import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `<b>🔒 PMCaptcha v5.0.7 帮助</b>

自动拦截陌生人私聊，发送验证题，通过后放行，失败后执行屏蔽/举报等操作 ⛑️

<b>📌 快速开始（按顺序执行）：</b>
1️⃣ <code>${p}pmc on</code> - 启用插件
2️⃣ <code>${p}pmc captcha on</code> - 开启验证功能
3️⃣ <code>${p}pmc captcha math</code> - 选择验证模式
4️⃣ <code>${p}pmc set fail 屏蔽</code> - 设置失败后动作

<b>🔧 基础操作：</b>
<blockquote expandable>• <code>${p}pmc on</code> / <code>off</code>
  启用或禁用插件（关闭时验证设置保留不变）
• <code>${p}pmc status</code>
  查看启用状态、验证模式、白名单和待验证人数
• <code>${p}pmc help</code>
  查看完整帮助</blockquote>

<b>🔐 验证设置：</b>
<blockquote expandable>• <code>${p}pmc captcha on</code> / <code>off</code>
  开启或关闭验证功能
• <code>${p}pmc captcha math</code>
  算术验证（默认，随机加法，无需额外依赖）
• <code>${p}pmc captcha text</code>
  关键词验证（回复设置的关键词）
• <code>${p}pmc captcha img_digit</code>
  图片验证码（5位纯数字；缺少 canvas 时自动降级为算术验证）
• <code>${p}pmc captcha img_mixed</code>
  图片验证码（5位字母+数字；缺少 canvas 时自动降级为算术验证）</blockquote>

<b>⚙️ 参数设置：</b>
<blockquote expandable>• <code>${p}pmc set time &lt;秒&gt;</code>
  验证超时（0 = 不限时，默认 30）
• <code>${p}pmc set tries &lt;次&gt;</code>
  最大尝试次数（0 = 不限，默认 3）
• <code>${p}pmc set keyword &lt;关键词&gt;</code>
  文字模式关键词（默认"我同意"）
• <code>${p}pmc set prompt &lt;文本&gt;</code>
  自定义验证提示（留空恢复默认）
  └ math 模式：{question} → 题目占位符
  └ text 模式：{keyword} → 关键词占位符
• <code>${p}pmc set fail 屏蔽/删除/举报/静音/归档/无</code>
  失败后动作（可多选，空格分隔）
  示例：<code>${p}pmc set fail 屏蔽 举报</code>
• <code>${p}pmc set pass 取消静音/取消归档/白名单/无</code>
  通过后动作（可多选）
  设置将用于后续验证处理</blockquote>

<b>👥 白名单管理：</b>
<blockquote expandable>• <code>${p}pmc add &lt;ID/@user&gt;</code>
  添加白名单（支持回复消息）
• <code>${p}pmc del &lt;ID/@user&gt;</code>
  移除白名单
• <code>${p}pmc wl</code>
  查看白名单列表
• <code>${p}pmc wl add &lt;ID/@user&gt;</code>
  同 add（支持回复消息）
• <code>${p}pmc wl del &lt;ID/@user&gt;</code>
  同 del
• <code>${p}pmc wl del all</code>
  清空白名单
• <code>${p}pmc wl pass &lt;ID/@user&gt;</code>
  手动标记通过并加入白名单</blockquote>

<b>📋 验证记录：</b>
<blockquote expandable>• <code>${p}pmc record</code>
  通过/失败人数摘要
• <code>${p}pmc record verified</code>
  查看验证通过记录
• <code>${p}pmc record failed</code>
  查看验证失败记录
</blockquote>

<b>🤖 自动过白规则：</b>
<blockquote expandable>优先级顺序依次检查（有规则触发即停止）：
1️⃣ 主动对话 — 我方主动发起私聊时对方自动通过
2️⃣ 聊天记录 — 用户历史消息数 ≥ N 时自动通过
3️⃣ 共同群 — 用户与自己的共同群 ≥ N 个时自动通过
4️⃣ 关键词 — 消息包含白名单词自动通过，黑名单词自动拦截
5️⃣ Premium — 根据策略自动通过/拦截 Premium 用户

• <code>${p}pmc set initiative on/off</code> — 启用/禁用主动对话过白
• <code>${p}pmc set history &lt;N&gt;</code> — 聊天记录过白（-1=禁用）
• <code>${p}pmc set groups &lt;N&gt;</code> — 共同群过白（-1=禁用）
• <code>${p}pmc set wl-words &lt;词1 词2…&gt;</code> — 白名单关键词
• <code>${p}pmc set bl-words &lt;词1 词2…&gt;</code> — 黑名单关键词
• <code>${p}pmc set premium allow/ban/only/none</code> — Premium 策略</blockquote>

<b>ℹ️ 使用说明：</b>
• 陌生会话会先静音并归档；失败后的动作通过 set fail 配置
• 我方主动发起对话时对方自动通过验证
• 支持中/英文设置（如：屏蔽/block）
• 自动过白规则按优先级检查，任何规则触发立即处理

<b>命令别名：</b>
<code>${p}pmcaptcha</code> 与 <code>${p}pmc</code> 使用相同参数。`;
}
