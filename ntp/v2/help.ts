import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `NTP 对时


<code>${p}ntp</code> 查看与 NTP 的时间偏差
<code>${p}ntp s</code> 对时（需要系统权限）`;
}
