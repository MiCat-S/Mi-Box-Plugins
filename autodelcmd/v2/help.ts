import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🗑️ <b>命令自动删除</b>

按规则延迟删除自己发出的命令，或收藏夹中的命令消息。首次使用建立默认规则，功能默认关闭。

<b>启用与查看：</b>
• <code>${p}autodelcmd on</code> / <code>${p}autodelcmd off</code> — 开启或关闭新任务；别名 enable / disable
• <code>${p}autodelcmd status</code> — 查看开关、规则数和待删除数；别名 st
• <code>${p}autodelcmd list</code> — 查看规则、延迟、选项和 ID；别名 ls

<b>规则管理：</b>
• <code>${p}autodelcmd add 命令 延迟秒数 [参数...] [-r] [-e]</code> — 添加规则
• <code>${p}autodelcmd del 规则ID</code> — 按列表中的 ID 删除规则；del 也可写 remove
• <code>${p}autodelcmd reset</code> — 恢复默认规则并关闭功能

<b>参数与匹配：</b>
• 命令名填写字母、数字或下划线，不带前缀。执行时使用当前配置的前缀，命令别名按路由解析后的命令匹配。
• 延迟为 1–86400 的整数，单位秒。
• 多个“参数”表示允许的第一个参数，例如 list ls search 匹配任一对应子命令；参数值区分大小写。
• 带参数的规则优先于通用规则，匹配后使用第一条适用规则。
• <code>-e</code> 或 <code>--exact</code>：只匹配无参数调用，不能同时填写参数列表。
• <code>-r</code> 或 <code>--response</code>：在处理命令时，从最近 100 条消息中选择 ID 大于命令的消息，最多 3 条；普通对话仅选自己发出的消息，收藏夹按消息先后筛选。
• -r 按时间顺序选择，可能包含命令之后的其他消息；选择完成后才到达的结果不会追加到本次删除任务。

<b>使用示例：</b>
<code>${p}autodelcmd list</code>
<code>${p}autodelcmd add calc 45 -e</code>
<code>${p}autodelcmd on</code>
要调整已有规则，先从 list 找到 ID，用 <code>${p}autodelcmd del 1</code> 这样的格式删除对应规则，再重新添加。

<b>任务与常见提示：</b>
• 关闭功能或删除规则只影响后续匹配；已经排定的删除仍可能执行。reset 也不会取消当前正在等待的定时任务。
• 待删除任务会持久保存，重启后继续处理保留的任务。
• “规则冲突”会给出 ID，先核对并删除该条规则，再添加新配置。
• 删除能力受当前对话的 Telegram 权限限制。

<code>${p}autodelcmd</code>、<code>${p}autodelcmd help</code> 或 <code>${p}help autodelcmd</code> 查看本说明。`;
}
