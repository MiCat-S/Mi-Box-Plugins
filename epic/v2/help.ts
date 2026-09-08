import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `⚙️ <b>Epic 限免游戏</b>

<b>📝 功能描述:</b>
• 获取 Epic Games 每周限免游戏信息
• 显示游戏详情、原价、限免时间

<b>🔧 使用方法:</b>
• <code>${p}epic</code> - 查看当前限免游戏

<b>📊 数据来源:</b>
• Epic Games Store API`;
}
