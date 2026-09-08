import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `妹子图片插件 - 从 FinelyGirlsBot 获取各类图片

🎨 <b>妹子图片插件</b>

<b>命令：</b>
• <code>${p}botmzt</code> - 显示插件设置和帮助
• <code>${p}rand</code> - 随机图片
• <code>${p}pic</code> - 妹子图片
• <code>${p}leg</code> - 腿部图片
• <code>${p}ass</code> - 臀部图片
• <code>${p}chest</code> - 胸部图片
• <code>${p}coser</code> - Cosplay图片
• <code>${p}nsfw</code> - NSFW图片
• <code>${p}naizi</code> - 奶子图片
• <code>${p}qd</code> - 签到命令

<b>说明：</b>
所有图片都会以剧透模式发送，需要点击查看。`;
}
