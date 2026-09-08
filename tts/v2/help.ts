import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🗣️ <b>Azure TTS</b> (微软语音合成)

<b>📝 功能:</b>
• 将文本转换为高质量语音
• 支持多种语音、情感和语速控制

<b>🔧 使用方法:</b>
• <code>${p}tts &lt;文本&gt;</code> - 合成语音
• <code>${p}tts config &lt;key&gt; &lt;region&gt;</code> - 配置 API
• <code>${p}tts voice &lt;VoiceName&gt;</code> - 设置语音
• <code>${p}tts style &lt;Style&gt;</code> - 设置风格 (如 cheerful, sad, chat, clear)
• <code>${p}tts rate &lt;Rate&gt;</code> - 设置语速 (0.5 ~ 2.0, 默认为 1.0)
• <code>${p}tts voices [filter]</code> - 列出音色 (默认 zh-CN)
• <code>${p}tts list</code> - 查看当前配置

<b>💡 提示:</b>
• 样式需要该音色支持才能生效 (如 Xiaoxiao 支持 cheerful)
• 清除风格使用 <code>${p}tts style clear</code>

<b>密钥配置：</b>
涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。`;
}
