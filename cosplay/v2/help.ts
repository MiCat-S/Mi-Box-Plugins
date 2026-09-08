import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `从 cosplaytele.com 随机获取cosplay图片

• ${p}cos [数量] - 从随机套图中获取指定数量的cosplay图片 (默认1张，最大10张)
• ${p}cosplay [数量] - 同cos命令

✨ 智能随机: 每次随机选择套图，确保多张图片来自同一套图，只获取高质量的gallery图片
🔗 套图链接: 发送图片时自动包含原套图链接，方便查看完整套图`;
}
