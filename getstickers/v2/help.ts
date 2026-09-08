import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🧩 <b>贴纸包打包下载</b>

<b>命令</b>
• <code>${p}getstickers</code>（回复任意贴纸）

<b>功能</b>
• 从回复的贴纸中识别贴纸包并下载全部贴纸
• 使用 FFmpeg 自动转换所有格式为 gif（方便微信使用）
• 支持 webp、tgs、mp4 格式转换
• 自动生成 pack.txt 与全部资源，并以 ZIP 发送

<b>用法</b>
1) 回复一张贴纸并发送 <code>${p}getstickers</code>

<b>依赖安装</b>
• <b>FFmpeg</b>（必需）:
  - Windows: <code>choco install ffmpeg</code>
  - macOS: <code>brew install ffmpeg</code>
  - Linux: <code>sudo apt install ffmpeg</code>
• <b>lottie</b>（tgs转换需要）:
  - <code>pip install lottie[all]</code>

<b>注意</b>
• 若贴纸包很大，处理时间较长，请耐心等待`;
}
