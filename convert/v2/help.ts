import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🎬 <b>视频转音频 AI 助手</b>

<b>✅ 功能:</b>
 • <b>AI 智能识别:</b> 使用 <code>u</code> 参数，AI 将自动查找最匹配的歌曲元数据和封面。
 • <b>自定义文件名:</b> 不使用 <code>u</code> 参数时，可直接指定输出的 MP3 文件名。
 • <b>高质量转换:</b> 将视频的音轨转换为高质量的 MP3 文件。
 • <b>元数据嵌入:</b> AI 模式下，会自动将歌曲名、歌手、专辑和封面嵌入文件。

<b>📝 命令用法:</b>

 • <b>AI 智能转换 (推荐):</b>
   <code>${p}convert u &lt;歌曲名&gt;</code>
   示例: <code>${p}convert u 稻香</code>

 • <b>标准转换 (自定义文件名):</b>
   <code>${p}convert [文件名]</code>
   示例: <code>${p}convert 周杰伦-稻香-演唱会版</code>
   <i>注意: 如果不提供文件名，将使用视频原名。</i>

 • <b>AI 功能配置:</b>
   <code>${p}convert apikey &lt;你的 Gemini API Key&gt;</code>
   <code>${p}convert apikey</code> (查看当前 Key)
   <code>${p}convert apikey clear</code> (清除 Key)

 • <b>其他命令:</b>
   <code>${p}convert clear</code> (清理临时文件)

<b>密钥配置：</b>
涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。`;
}
