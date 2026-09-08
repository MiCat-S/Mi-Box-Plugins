import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🖼️ <b>图片转贴纸工具</b>

<b>📝 功能：</b>
• 将图片转换为高质量贴纸
• 支持多种图片格式（JPG/PNG/GIF/WEBP）
• 自动优化贴纸尺寸和质量
• 支持自定义表情和背景
• 批量处理多张图片

<b>🔧 使用：</b>
• <code>${p}pts</code> - 转换回复的图片
• <code>${p}pts [表情]</code> - 使用自定义表情
• <code>${p}pts config</code> - 查看/修改配置
• <code>${p}pts batch</code> - 批量转换（回复多张图片）

<b>⚙️ 配置选项：</b>
• <code>${p}pts config emoji [表情]</code> - 设置默认表情
• <code>${p}pts config size [256-512]</code> - 设置贴纸尺寸
• <code>${p}pts config quality [1-100]</code> - 设置质量
• <code>${p}pts config bg [transparent/white/black]</code> - 设置背景
• <code>${p}pts config auto [on/off]</code> - 自动删除原消息

<b>💡 示例：</b>
• <code>${p}pts</code> - 使用默认设置转换
• <code>${p}pts 😎</code> - 使用太阳镜表情
• <code>${p}pts config emoji 🔥</code> - 设置默认表情为火焰
• <code>${p}pts batch</code> - 批量转换多张图片

<b>📌 提示：</b>
• 支持回复图片消息或直接发送图片
• GIF动图将转换为动态贴纸
• 自动保持图片透明背景
• 智能压缩确保最佳质量

<b>命令别名：</b>
<code>${p}pic_to_sticker</code> 与 <code>${p}pts</code> 使用相同参数。`;
}
