import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `Komari 服务器监控插件：
基于 Komari API 获取服务器和节点状态信息

命令：
• <code>${p}komari status</code> - 获取服务器基本信息
• <code>${p}komari total</code> - 获取所有节点总览
• <code>${p}komari show &lt;节点名&gt;</code> - 查看指定节点详细状态

配置命令：
• <code>${p}komari _set_url &lt;URL&gt;</code> - 设置 Komari 服务器地址`;
}
