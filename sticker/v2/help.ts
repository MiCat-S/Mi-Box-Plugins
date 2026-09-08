import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `⭐ <b>贴纸收藏插件</b>

<b>📝 功能描述:</b>
• 💾 <b>一键收藏</b>：回复任意贴纸即可快速保存到您的贴纸包。
• 🤖 <b>全自动处理</b>：自动创建贴纸包，并在包满时自动创建新包。
• 📁 <b>自定义包</b>：可设置一个默认的贴纸包，或临时保存到指定包。
• ✨ <b>类型支持</b>：完美支持普通、动态（.tgs）和视频（.webm）贴纸。

<b>🔧 使用方法:</b>
• 回复一个贴纸，发送 <code>${p}sticker</code> - 保存贴纸到默认或自动创建的包。
• <code>${p}sticker to &lt;包名&gt;</code> - (回复贴纸时) 临时保存到指定包。
• <code>${p}sticker cancel</code> - 取消设置的默认贴纸包。
• <code>${p}sticker</code> - (不回复贴纸) 查看当前配置。

<b>💡 使用示例:</b>
• 回复贴纸, 发送 <code>${p}sticker</code>
• <code>${p}sticker MyStickers</code>
• <code>${p}sticker cancel</code>
• 回复贴纸, 发送 <code>${p}sticker to TempPack</code>

<b>📌 注意事项:</b>
• 首次使用前，请确保您已私聊过官方的 @Stickers 机器人。
• 贴纸包名称只能包含字母、数字和下划线，且必须以字母开头。
• 若被收藏贴纸未携带基础 emoji，将自动随机选择一个基础表情作为标签。`;
}
