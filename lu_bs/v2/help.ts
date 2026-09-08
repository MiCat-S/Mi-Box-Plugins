import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🕒 <b>鲁小迅整点报时</b>

<b>功能说明：</b>
• 每小时整点自动发送鲁小迅贴纸报时
• 自动删除上一条报时消息（1小时后）
• 支持群组和私聊订阅

<b>可用命令：</b>
• <code>${p}lu_bs sub</code> - 订阅整点报时
• <code>${p}lu_bs unsub</code> - 退订整点报时
• <code>${p}lu_bs list</code> - 查看订阅状态
• <code>${p}lu_bs reload</code> - 重新加载贴纸包

<b>注意事项：</b>
• 需要管理员权限才能操作群组订阅
• 请先添加贴纸包: <code>https://t.me/addstickers/luxiaoxunbs</code>`;
}
