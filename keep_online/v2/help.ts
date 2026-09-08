import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🟢 <b>在线状态探针</b>

每分钟第 55 秒验证一次 Telegram 会话，成功后写入当前 Unix 时间戳。

<b>使用方法：</b>
• <code>${p}keep_online</code> - 查看最近成功探测时间

<b>探测文件：</b>
• <code>assets/keep_online/keep_online.txt</code>
• 文件内容为秒级时间戳

外部定时任务可读取该文件，并根据时间戳判断是否需要重启服务；读取路径应使用部署时对应的挂载位置。`;
}
