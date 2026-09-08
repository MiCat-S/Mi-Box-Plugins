import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `词云 cy

立即生成
${p}cy
${p}cy 500
${p}cy send

定时发送
${p}cy target here
${p}cy target @群用户名
${p}cy time 09:00 500
${p}cy time 09:00,21:30 1000
${p}cy time 05:00 12:00 21:30 2000
${p}cy on
${p}cy off
${p}cy status

帮助
${p}cy help
${p}help cy`;
}
