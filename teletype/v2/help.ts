import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `⌨️ <b>打字机效果插件</b>

<b>命令格式：</b>
<code>${p}teletype [文本]</code> - 手动打字机效果
<code>${p}teletype on/off</code> - 开启或关闭自动模式
<code>${p}teletype status</code> - 查看状态

<b>使用示例：</b>
<code>${p}teletype Hello World!</code>
<code>${p}teletype on/off</code>
<code>${p}teletype status</code>`;
}
