import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `点兵点将
<code>${p}dbdj 消息数 人数 文案</code> - 从最近的消息中随机抽取指定人数的用户`;
}
