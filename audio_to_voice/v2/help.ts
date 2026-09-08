import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🎙️ <b>音频转语音</b>

<b>命令</b>
• <code>${p}audio_to_voice</code>（回复一条包含音乐的消息）

<b>功能</b>
• 将音乐文件转换为 Telegram 语音消息（OGG/Opus）

<b>用法</b>
1) 回复音乐文件发送 <code>${p}audio_to_voice</code>

<b>依赖</b>
• 需要系统安装 FFmpeg`;
}
