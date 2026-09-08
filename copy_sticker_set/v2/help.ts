import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📦 <b>复制贴纸包</b>

<b>命令格式</b>
• <code>${p}copy_sticker_set ＜贴纸包＞ [自定义名称] [limit=数字]</code>
• <code>${p}css ＜贴纸包＞ [自定义名称] [limit=数字]</code>

<b>参数说明</b>
• <code>＜贴纸包＞</code> - 贴纸包链接或短名称（必填）
• <code>[自定义名称]</code> - 新贴纸包的标题（可选）
• <code>[limit=数字]</code> - 限制复制数量（最大 120，默认 100）

<b>使用示例</b>
• <code>${p}copy_sticker_set https://t.me/addstickers/example</code>
• <code>${p}copy_sticker_set example_stickers</code>
• <code>${p}copy_sticker_set example_stickers 我的专属贴纸包</code>
• <code>${p}css example_stickers 我的专属贴纸包 limit=80</code>

<b>注意事项</b>
• 复制的贴纸包将保存到你的账户中
• 如不指定名称，将使用原贴纸包名称
• 支持静态和动态贴纸包
• 平台限制：最多允许 120 张（超过将报错）`;
}
