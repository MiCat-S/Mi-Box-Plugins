import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🔑 <b>API 检测工具</b>

管理 OpenAI 兼容 API，检查连接、模型列表与对话返回。

<b>配置管理：</b>
• <code>${p}checkapi save 名称 URL Key</code> - 保存或更新连接，并验证模型接口；请在收藏夹中执行
• <code>${p}checkapi list</code> - 查看已保存连接，密钥以遮罩显示
• <code>${p}checkapi del 名称</code> - 删除连接

<b>检测与提问：</b>
• <code>${p}checkapi check 名称</code> - 检查模型接口是否有效
• <code>${p}checkapi models 名称</code> - 查看模型列表（最多 100 个）
• <code>${p}checkapi ask 名称 问题</code> - 使用 gpt-4o-mini 发送测试提问
• 以上检测命令也可将“名称”替换为 <code>URL Key</code>

<b>示例：</b>
• <code>${p}checkapi save demo https://api.example.com/v1 sk-example</code>
• <code>${p}checkapi models demo</code>
• <code>${p}checkapi ask demo 你好</code>

URL 应填写 API 基址，例如以 <code>/v1</code> 结尾的兼容接口地址。`;
}
