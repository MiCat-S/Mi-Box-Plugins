import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📊 年度报告插件

使用 ${p}annualreport 生成您的Telegram年度报告

<b>报告内容：</b>
显示账号会话分类、黑名单人数、Premium 状态、已激活插件数量和报告生成记录。`;
}
