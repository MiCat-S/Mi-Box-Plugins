import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `回复消息并使用 ${p}bd, 删除从被回复的消息到当前指令之间的所有消息。或使用 ${p}bd ＜数字＞ 删除您最近的消息。使用 ${p}bd on/off 切换删除他人消息的权限。`;
}
