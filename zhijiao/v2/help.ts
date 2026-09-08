import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `掷筊
强随机 使用 笅杯卦辞廿七句

<code>${p}zhijiao</code> 掷筊`;
}
