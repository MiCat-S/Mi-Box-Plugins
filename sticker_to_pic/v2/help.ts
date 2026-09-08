import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🖼️ <b>贴纸转图片插件</b>

<b>📝 功能描述:</b>
• 🔄 <b>格式转换</b>：将Telegram贴纸转换为JPG/PNG图片
• 🎨 <b>透明处理</b>：支持保持或移除透明背景
• 📄 <b>文档模式</b>：支持以文档形式发送原图
• ⚡ <b>依赖检测</b>：使用前检测 ImageMagick，不会自动安装系统软件

<b>🔧 使用方法:</b>
• <code>${p}sticker_to_pic</code> - 转换为JPG（回复贴纸）
• <code>${p}stp</code> - 快捷命令
• <code>${p}stp png</code> - 转换为PNG格式
• <code>${p}stp transparent</code> - PNG格式保持透明
• <code>${p}stp doc</code> - 以文档形式发送源文件

<b>💡 示例:</b>
• <code>${p}stp</code> - 转换为JPG图片
• <code>${p}stp png</code> - 转换为PNG图片
• <code>${p}stp transparent</code> - PNG透明背景
• <code>${p}stp doc</code> - 文档模式发送

<b>🔄 管理命令:</b>
• <code>${p}stp check</code> - 检查 ImageMagick 状态

<b>📋 支持格式:</b>
• 输入：WebP贴纸文件
• 输出：JPG（默认）、PNG
• 透明：仅PNG格式支持

<b>⚙️ 系统要求:</b>
• ImageMagick（需管理员显式安装）`;
}
