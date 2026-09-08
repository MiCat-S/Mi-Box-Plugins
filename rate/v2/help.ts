import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `加密货币汇率查询 & 数量换算

🚀 <b>智能汇率查询助手</b>

📊 <b>使用示例</b>
• <code>${p}rate BTC</code> - 比特币美元价
• <code>${p}rate ETH CNY</code> - 以太坊人民币价
• <code>${p}rate CNY TRY</code> - 人民币兑土耳其里拉
• <code>${p}rate BTC CNY 0.5</code> - 0.5个BTC换算
• <code>${p}rate CNY USDT 7000</code> - 7000元换USDT`;
}
