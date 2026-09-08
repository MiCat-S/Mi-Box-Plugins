import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `定时发送/转发/复制/置顶/取消置顶/删除消息/执行命令

▎定时复制

每天2点复制发送到指定对话(可指定话题或回复消息)

• 使用 <code>${p}acron copy 0 0 2 * * * 对话ID/@name [备注]</code> 回复一条消息
• 使用 <code>${p}acron copy 0 0 2 * * * 对话ID/@name|发送时的话题ID或回复消息的ID [备注]</code> 回复一条消息

▎定时转发

每天2点转发到指定对话(可指定话题)

• 使用 <code>${p}acron forward 0 0 2 * * * 对话ID/@name [备注]</code> 回复一条消息
• 使用 <code>${p}acron forward 0 0 2 * * * 对话ID/@name|发送时的话题ID [备注]</code> 回复一条消息

▎定时发送

保存被回复消息的文本，每天2点在指定对话发送（可指定话题或回复消息）。需要保留媒体与原消息格式时，请使用定时复制/转发功能。

• 使用 <code>${p}acron send 0 0 2 * * * 对话ID/@name [备注]</code> 回复一条消息
• 使用 <code>${p}acron send 0 0 2 * * * 对话ID/@name|发送时话题的ID或回复消息的ID [备注]</code> 回复一条消息

▎定时删除

每天2点删除指定ID或@name的对话中的指定ID的消息

• <code>${p}acron del 0 0 2 * * * 对话ID/@name 消息ID [备注]</code>

▎定时正则删除

每天2点删除指定ID或@name的对话中的最近的 100 条消息中 内容符合正则表达式的消息

• <code>${p}acron del_re 0 0 2 * * * 对话ID/@name 100 /^test/i [备注]</code>

▎定时置顶/取消置顶

每天2点在指定ID或@name的对话中置顶指定ID的消息, 是否发通知(true/1, false/0), 是否仅对自己置顶(true/1, false/0)

• <code>${p}acron pin 0 0 2 * * * 对话ID/@name 消息ID 是否发通知 是否仅对自己置顶 [备注]</code>

每天2点在指定ID或@name的对话中取消置顶指定ID的消息

• <code>${p}acron unpin 0 0 2 * * * 对话ID/@name 消息ID [备注]</code>

▎定时执行命令

每天2点在指定ID或@name的对话中执行命令 <code>${p}a foo bar</code>(可指定话题或回复消息)
注意要换行写

<pre>${p}acron cmd 0 0 2 * * * 对话ID/@name [备注]
${p}a foo bar</pre>

<pre>${p}acron cmd 0 0 2 * * * 对话ID/@name|发送时话题的ID或回复消息的ID [备注]
${p}a foo bar</pre>

典型的使用场景:

每天2点自动备份(调用 <code>${p}bf</code> 命令)

<pre>${p}acron cmd 0 0 2 * * * me 定时备份
${p}bf</pre>

每天2点发送状态查询命令（调用 <code>${p}ping</code> 命令）

<pre>${p}acron cmd 0 0 2 * * * me 定时状态查询
${p}ping</pre>

• <code>${p}acron list</code>, <code>${p}acron ls</code> - 列出当前会话中的所有定时任务
• <code>${p}acron ls all</code>, <code>${p}acron la</code> - 列出所有的定时任务
• <code>${p}acron ls del</code> - 列出当前会话中的类型为 del 的定时任务
• <code>${p}acron ls all del</code>, <code>${p}acron la del</code> - 列出所有的类型为 del 的定时任务
• <code>${p}acron rm 定时任务ID</code> - 删除指定的定时任务
• <code>${p}acron disable/off 定时任务ID</code> - 禁用指定的定时任务
• <code>${p}acron enable/on 定时任务ID</code> - 启用指定的定时任务

<b>Cron 格式：</b>
使用六段表达式：<code>秒 分 时 日 月 星期</code>；时区为 <code>Asia/Shanghai</code>。`;
}
