import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `BIN 查询插件

💳 <b>BIN 查询</b>

<b>用法：</b>
• <code>${p}bin &lt;卡头6-8位&gt;</code>

<b>示例：</b>
• <code>${p}bin 415042</code>

<b>数据源：</b> Bincheck 优先，Binlist 备用`;
}
