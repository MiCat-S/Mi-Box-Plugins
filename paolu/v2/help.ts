import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `群组一键跑路插件 - 删除消息并禁言所有成员

<b>⚠️ 一键跑路</b>

<code>${p}paolu</code> - 删除群内所有消息并禁言所有成员

<b>警告：</b>此操作不可逆，请谨慎使用！`;
}
