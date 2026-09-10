import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📊 <b>哪吒监控</b>

连接哪吒面板，查看服务器状态、服务监控延迟和延迟图表。

<b>首次配置：</b>
在收藏夹执行 <code>${p}nezha set 面板地址 JWT_SECRET</code>。
JWT_SECRET 填写面板配置中的 jwt_secret_key 原始值。命令会先验证服务器接口，成功后保存。
示例：<code>${p}nezha set https://nezha.example.com your_jwt_secret</code>

<b>查询与设置：</b>
• <code>${p}nezha</code> — 查看全部服务器，在线服务器优先，长列表自动分页
• <code>${p}nezha service on</code> / <code>${p}nezha service off</code> — 开启或关闭列表中的服务延迟显示，默认开启
• <code>${p}nezha chart 服务器名或ID</code> — 生成指定服务器的服务延迟图表
• <code>${p}nezha set 面板地址 JWT_SECRET</code> — 更新连接配置，保留原有显示开关

<b>示例：</b>
<code>${p}nezha</code>
<code>${p}nezha service off</code>
<code>${p}nezha chart 1</code>
<code>${p}nezha chart 香港节点</code>

<b>配置与数据范围：</b>
• 面板地址使用 HTTP/HTTPS 地址，可包含部署子路径。
• 需要面板提供当前插件使用的 /api/v1/server 和服务监控接口，并接受 JWT 认证。
• 连接配置在各对话间共用；密钥设置仅限收藏夹，也可通过插件设置填写面板地址和 JWT Secret。
• 图表使用 QuickChart 生成，相关图表数据会发送到 quickchart.io。

<b>常见提示：</b>
• “请先配置”：在收藏夹完成 set。
• HTTP 或验证失败：检查面板地址、JWT Secret 和面板接口兼容性。
• 图表缺少数据：核对服务器名/ID，并检查该节点是否存在服务监控记录。

<code>${p}nezha help</code> / <code>${p}help nezha</code> 查看本说明。`;
}
