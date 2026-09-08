import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `使用 <code>${p}bs [消息数]</code> 回复一条消息

首次使用请先通过 <code>${p}bs add</code> 配置转发目标

<code>${p}bs add 对话 ID/对话名[|话题ID]</code>: 添加目标(支持指定话题 ID)
<code>${p}bs ls</code>, <code>${p}bs list</code>: 列出所有目标
<code>${p}bs del [id]</code>, <code>${p}bs rm [id]</code>: 移除指定目标
<code>${p}bs enable [id]</code>, <code>${p}bs on [id]</code>: 启用指定目标
<code>${p}bs disable [id]</code>, <code>${p}bs off [id]</code>: 禁用指定目标
<code>${p}bs toggle mode</code>: 切换模式, 默认是按顺序优先发送, 发送成功就不继续. 可切换为每个目标都尝试发送`;
}
