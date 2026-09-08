import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📦 <b>Biko - 批量获取整理发送指定对话中指定用户的消息</b>

<b>格式：</b>
<code>${p}biko 对话id(或@对话) 用户id(或@用户) 最大消息数 目标对话id(或@目标)</code>

<b>示例：</b>
<code>${p}biko -1001234567890 123456789 20 @targetchat</code>
<code>${p}biko @sourcechat @alice 30 -1009876543210</code>

<b>说明：</b>
• 最大消息数上限为 200
• 输出包含时间和消息内容
• 能生成原消息链接时会自动附加可点击超链接
• 源用户实体解析失败时，会自动降级为手动过滤模式

若想实现定时任务, 可安装并使用 <code>${p}tpm i acron</code>
每天 2 点 从 对话 <code>@group</code> 中获取 <code>@user</code> 的 20 条消息并发送到人形账号的收藏夹 (Saved Messages)

<pre>${p}acron cmd 0 0 2 * * * me 尾行
${p}biko @group @user 20 me</pre>`;
}
