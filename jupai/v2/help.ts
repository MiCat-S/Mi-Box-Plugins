import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `举牌小人


生成举牌小人图片

<code>${p}jupai [文本]</code> - 生成举牌小人
或回复消息使用 <code>${p}jupai</code> - 将回复的消息内容生成举牌小人

示例：
<code>${p}jupai 你好世界</code>`;
}
