import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📡 <b>Komari 服务器监控</b>

连接 Komari 服务，查看面板信息、节点总览和单个节点详情。

<b>首次配置：</b>
<code>${p}komari _set_url https://komari.example.com</code>
地址也可在插件设置的“服务地址”字段保存；配置在各对话间共用。

<b>命令：</b>
• <code>${p}komari</code> — 查看服务器基本信息，等同于 status
• <code>${p}komari status</code> — 查看服务端基本信息
• <code>${p}komari total</code> — 查看全部节点总览
• <code>${p}komari show 节点名</code> — 查看指定节点详情，名称可包含空格
• <code>${p}komari _set_url 地址</code> — 保存或更新服务地址

<b>完整示例：</b>
1. <code>${p}komari _set_url https://komari.example.com</code>
2. <code>${p}komari status</code>
3. <code>${p}komari total</code>
4. 从总览复制节点名，例如 <code>${p}komari show 香港节点</code>

<b>地址与输出：</b>
• 支持 HTTP/HTTPS 地址，省略协议时默认 HTTPS；部署子路径会保留。
• 需要当前插件使用的 Komari 接口可直接访问，连接配置仅提供服务地址。
• 设置地址时只校验格式，查询时才验证连接与响应；长报告自动分页。

<b>常见提示：</b>
• 请先配置：执行 _set_url 保存地址。
• HTTP 或响应结构异常：检查地址、服务是否在线及接口兼容性。
• 节点未找到：用 total 核对节点名后再查询。

<code>${p}komari help</code> / <code>${p}help komari</code> 查看本说明。`;
}
