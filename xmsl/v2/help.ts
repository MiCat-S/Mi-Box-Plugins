import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🤢 <b>羡慕死了插件 - 快速赛博乞讨</b>

<b>📋 命令列表</b>

• <code>${p}xmsl [内容]</code> 或 <code>${p}xm [内容]</code> - 生成羡慕语句
• <code>${p}xmsl</code>回复图片/贴纸 - 识别图片生成羡慕语句
• <code>${p}xmsl</code> 或 <code>${p}xm</code> - 显示状态
• <code>${p}xm set [key] [value]</code> - 修改配置
• <code>${p}xm show</code> - 显示配置

<b>🖼️ 支持的媒体类型</b>
• 图片 (jpeg/png/gif)
• 静态贴纸 (webp)
• 视频贴纸 (webm) - 需要 ffmpeg
• 动态贴纸 (tgs) - 需要 rlottie-python + ffmpeg

<b>⚙️ 配置项</b>
• <code>mode</code> - API模式 (openai|gemini)
• <code>key</code> - API密钥
• <code>url</code> - API地址
• <code>model</code> - 模型名称

<b>密钥配置：</b>
涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。`;
}
