import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🌐 BGP路由图查询工具

• <code>${p}bgp &lt;IP&gt;</code> - 查询指定IP的BGP路由图
• <code>${p}bgp</code> - 回复包含IP的消息自动查询BGP路由图
• <code>${p}bgp dns &lt;IP&gt;</code> - 查询指定IP的DNS解析记录
• <code>${p}bgp dns</code> - 回复包含IP的消息查询DNS解析记录`;
}
