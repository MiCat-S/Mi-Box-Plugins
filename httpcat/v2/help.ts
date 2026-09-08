import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `HTTP猫猫图片


发送 HTTP 状态码对应的猫猫图片

<code>${p}httpcat [状态码]</code> 例如 <code>${p}httpcat 404</code>`;
}
