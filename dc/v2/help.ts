import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📍 <b>Telegram 数据中心查询</b>

<b>使用方法：</b>
• <code>${p}dc</code> - 查询当前群组或频道头像所在的数据中心
• <code>${p}dc @用户名</code> - 查询指定用户
• <code>${p}dc 用户ID</code> - 按用户 ID 查询
• 回复目标消息后发送 <code>${p}dc</code> - 查询发送者，或消息所在群组/频道

<b>说明：</b>
• 结果来自 Telegram 头像信息，目标需要设置头像
• DC 表示 Telegram 数据中心编号，不代表用户所在地
• 每次最多指定一个目标`;
}
