import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🧮 <b>计算器插件</b>

<b>📝 功能描述:</b>
• 执行安全的四则运算表达式
• 支持括号、小数以及负数

<b>🔧 使用方法:</b>
• <code>${p}calc 2+2*5</code>
• <code>${p}calc (10-3)*4</code>
• <code>${p}calc -(2-5)/3</code>

<b>💡 示例:</b>
• <code>${p}calc 3+7</code> → 10
• <code>${p}calc 8/2+5</code> → 9`;
}
