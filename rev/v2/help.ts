import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🔄 <b>反转插件</b>

<b>✨ 功能介绍</b>
支持文字和媒体的多种反转操作，让你的内容倒过来！

<b>📝 文字反转</b>
• <code>${p}rev [文字]</code> - 反转文字内容（支持 emoji）
• <code>${p}rev</code>（回复文字消息）- 反转回复的文字

<b>🖼️ 媒体反转</b>
支持格式：图片 / GIF / WebM / WebP
• <code>${p}rev</code>（回复媒体）- 水平翻转
• <code>${p}rev h</code> - 水平翻转（左右镜像）
• <code>${p}rev v</code> - 垂直翻转（上下镜像）
• <code>${p}rev c</code> - 颜色反转（负片效果）
• <code>${p}rev h c</code> - 组合使用（水平翻转 + 颜色反转）

<b>💡 使用示例</b>
• <code>${p}rev 你好世界</code> → 界世好你
• 回复图片 + <code>${p}rev v</code> → 上下翻转的图片
• 回复 GIF + <code>${p}rev c</code> → 负片效果的 GIF
• 回复 WebM + <code>${p}rev h c</code> → 水平翻转 + 负片效果`;
}
