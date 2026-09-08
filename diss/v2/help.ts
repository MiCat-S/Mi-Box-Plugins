import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🗣️ 儒雅随和版祖安语录

使用 ${p}diss 触发`;
}
