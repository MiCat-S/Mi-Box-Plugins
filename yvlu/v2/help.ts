import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `生成文字语录贴纸

- 不包含回复
<blockquote expandable>使用 <code>${p}yvlu [消息数]</code> 回复一条消息(支持选择部分引用回复) ⚠️ 不得超过 5 条</blockquote>

- 包含回复
<blockquote expandable>使用 <code>${p}yvlu r [消息数]</code> 回复一条消息(支持选择部分引用回复) ⚠️ 不得超过 5 条</blockquote>

- 伪造消息
<blockquote expandable>使用 <code>${p}yvlu f 伪造消息</code> 回复一条消息
使用 <code>${p}yvlu fr 伪造消息</code> 回复一条消息并包含回复内容</blockquote>

- 伪造发送者
<blockquote expandable>使用 <code>${p}yvlu u 用户ID/用户名 [消息数]</code> 回复一条消息
使用 <code>${p}yvlu ur 用户ID/用户名 [消息数]</code> 回复一条消息并包含回复内容</blockquote>

- 输出格式（默认 webp 贴纸）
<blockquote expandable>使用 <code>${p}yvlu webp</code> - 静态 WebP 贴纸
使用 <code>${p}yvlu image</code> - 背景大图 (PNG)
使用 <code>${p}yvlu stories</code> - 故事模式 (720×1280 PNG)</blockquote>

- 保存贴纸/图片到贴纸包
<blockquote expandable>使用 <code>${p}yvlu s</code> 回复一张贴纸或图片,将其保存到配置的贴纸包中</blockquote>

- 配置管理
<blockquote expandable>使用 <code>${p}yvlu config</code> 查看当前配置
使用 <code>${p}yvlu config sticker 贴纸包名称</code> 设置贴纸包名称</blockquote>

<b>格式组合：</b>
• <code>${p}yvlu r image 3</code> - 生成包含引用内容的 PNG 图片
• <code>png</code> 是 <code>image</code> 的别名；贴纸包配置支持 <code>sticker</code>、<code>stickerset</code>、<code>set</code>。`;
}
