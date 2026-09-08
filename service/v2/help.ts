import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `⚙️ <b>systemd 服务状态</b>

显示服务的运行状态、运行时间、内存和 CPU 使用情况。

<b>使用方法：</b>
• <code>${p}service</code> - 自动检测当前进程对应的服务
• <code>${p}service 服务名</code> - 查看指定服务

<b>示例：</b>
• <code>${p}service ssh</code>
• <code>${p}service mibot.service</code>

适用于提供 systemd 与 systemctl 的 Linux 环境。`;
}
