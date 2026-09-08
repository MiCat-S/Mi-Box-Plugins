import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🐟 <b>摸鱼日报</b>

获取今日摸鱼日报图片，附带日期与每日提醒。

<b>使用方法：</b>
• <code>${p}moyu</code> - 获取今日摸鱼日报
• <code>${p}moyu help</code> - 查看帮助`;
}
