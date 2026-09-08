import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🎲 随机色色视频获取

🎲 <b>随机色色视频获取</b>

<b>命令：</b>
• <code>${p}kkp</code> - 从SeSe3000Bot获取随机视频并转发

<b>说明：</b>
该插件会自动与SeSe3000Bot交互获取随机视频内容`;
}
