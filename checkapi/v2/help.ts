import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🔑 <b>API 检测工具</b>

保存 OpenAI 兼容 API 连接，检查模型接口和测试对话。

<b>连接管理：</b>
• <code>${p}checkapi save 名称 URL Key</code> — 保存或更新同名连接，并验证模型接口；仅限收藏夹
• <code>${p}checkapi list</code> — 查看连接名称、主机与遮罩密钥
• <code>${p}checkapi del 名称</code> — 删除指定连接

<b>检测与提问：</b>
• <code>${p}checkapi check 名称</code> — 验证模型接口，显示模型总数
• <code>${p}checkapi models 名称</code> — 完整显示接口返回的模型列表，长列表自动分页
• <code>${p}checkapi ask 名称 [问题]</code> — 使用 gpt-4o-mini 发送一次测试提问，省略问题时发送 say hello
• 上述检测命令也支持直接填写 URL Key，格式如 <code>${p}checkapi check URL Key</code>；包含密钥的命令请在收藏夹执行

<b>完整示例：</b>
1. <code>${p}checkapi save demo https://api.example.com/v1 sk-example</code>
2. <code>${p}checkapi check demo</code>
3. <code>${p}checkapi models demo</code>
4. <code>${p}checkapi ask demo 用一句话打招呼</code>

<b>参数与限制：</b>
• 名称不含空格，使用时按保存的名称匹配。
• URL 填 API 基址，例如 https://api.example.com/v1；插件在其后追加 /models 或 /chat/completions。
• ask 使用固定测试模型，输出请求上限为 100 tokens；模型列表成功不代表该模型可用。
• 单次 HTTP 请求限时 20 秒，响应体上限 1 MiB。
• 保存后验证失败时，连接仍已保存，可修正同名配置后重试。

<b>常见提示：</b>
• 要求提供已保存名称：先 list 核对连接名称。
• HTTP 错误：检查基址、密钥以及接口权限。
• 响应缺少模型或消息内容：检查接口是否兼容请求格式。

<code>${p}checkapi</code>、<code>${p}checkapi help</code> 或 <code>${p}help checkapi</code> 查看本说明。`;
}
