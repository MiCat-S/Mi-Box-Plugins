import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `✈️ 机场Affiliate信息管理

在别人要打算买机场的时候光速发出自己的aff信息（支持多条）

<b>使用方法：</b>
• <code>${p}aff</code> - 发送默认aff（如有多条则显示列表）
• <code>${p}aff &lt;序号&gt;</code> - 发送指定序号的aff
• <code>${p}aff list</code> - 查看所有已保存的aff
• <code>${p}aff save</code> - 回复一条消息以新增aff
• <code>${p}aff remove &lt;序号&gt;</code> - 删除指定aff

<b>列表与容量：</b>
• <code>${p}aff list 2</code> - 查看第 2 页，每页 10 条
• 最多保存 32 条，每条文本最多 4000 字符；序号从 1 开始。`;
}
