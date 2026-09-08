import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `👮 <b>一键 AT 管理员</b>

<b>📝 功能描述:</b>
• 🔔 <b>管理员召唤</b>：一键艾特群组内所有管理员
• 💬 <b>自定义消息</b>：可附带自定义召唤消息
• 📦 <b>智能分片</b>：自动分片避免消息过长
• 🤖 <b>过滤机器人</b>：自动排除机器人和已删除用户

<b>🔧 使用方法:</b>
• <code>${p}atadmins</code> - 使用默认消息召唤管理员
• <code>${p}atadmins [消息内容]</code> - 附带自定义消息召唤

<b>💡 示例:</b>
• <code>${p}atadmins</code> - 默认召唤
• <code>${p}atadmins 请查看置顶消息</code> - 自定义消息召唤
• <code>${p}atadmins 紧急情况需要处理</code> - 紧急召唤

<b>⚠️ 注意事项:</b>
• 仅限群组使用，私聊无效
• 需要获取群组管理员权限
• 自动删除召唤命令消息
• 支持回复消息时召唤管理员`;
}
