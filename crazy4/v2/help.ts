import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `疯狂星期四文案插件

🍗 <b>疯狂星期四插件</b>

<b>可用命令：</b>
• <code>${p}crazy4</code> - 随机发送一条疯狂星期四文案`;
}
