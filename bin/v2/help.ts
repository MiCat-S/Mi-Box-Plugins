import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `BIN 查询插件

💳 <b>BIN 查询</b>

<b>用法：</b>
• <code>${p}bin &lt;卡头6-8位&gt;</code>

<b>示例：</b>
• <code>${p}bin 415042</code>

<b>查询内容：</b> 卡组织、类型、级别、发卡行、国家区号、地区与货币。
<b>参考汇率：</b> 发卡币种及美元兑人民币，显示数据日期；不可用时保留卡片信息。

<b>数据源：</b> Binlist、Bincheck；汇率由 ExchangeRate-API 提供`;
}
