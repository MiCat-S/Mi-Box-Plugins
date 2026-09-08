import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📝 Pangu 消息格式化插件

⚙️ <b>pangu - 为消息添加「盘古之白」</b>

<b>📝 功能描述:</b>
• 自动在中英文、数字之间添加空格，使消息更美观易读
• 内置核心引擎，处理 CJK 与 字母/数字/符号 之间的间距
• 智能保护链接不被破坏

<b>🔧 使用方法:</b>
• <code>${p}pangu</code> - 查看当前状态/显示帮助
• <code>${p}pangu [文本]</code> - 测试格式化效果
• <code>${p}pangu on/off</code> - 在当前会话开启/关闭
• <code>${p}pangu global on/off</code> - 开启/关闭全局模式
• <code>${p}pangu whitelist add/remove</code> - 将当前会话加入/移出白名单
• <code>${p}pangu blacklist add/remove</code> - 将当前会话加入/移出黑名单
• <code>${p}pangu stats</code> - 查看统计信息

<b>📊 优先级说明:</b>
⚪ 白名单 > ⚫ 黑名单 > 💬 会话设置 > 🌐 全局模式`;
}
