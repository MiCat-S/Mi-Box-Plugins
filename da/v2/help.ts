import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `群组消息批量删除插件

<b>批量删除</b>

<code>${p}da true</code> 开始删除
<code>${p}da stop</code> 停止任务`;
}
