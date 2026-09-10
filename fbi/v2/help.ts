import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🕵️ <b>公开群组与频道消息查询</b>

从当前账号可见、已缓存的公开群组或频道消息中查询目标，并在观察到目标的新消息时通知。

<b>查询与任务：</b>
• <code>${p}fbi det [目标]</code> — 查询缓存中目标最新的一条消息
• <code>${p}fbi loc [目标]</code> — 按缓存消息数量寻找目标最活跃的群
• <code>${p}fbi sur [目标]</code> — 蹲守目标下一条可见的公开群组或频道消息
• <code>${p}fbi obs [目标]</code> — 在当前群定点蹲守
• <code>${p}fbi obs 群链接 [目标]</code> — 在指定公开群组或频道定点蹲守
• <code>${p}fbi ssv</code> — 终止全部蹲守任务

<b>目标与示例：</b>
目标填写 @用户名或用户 ID；回复用户消息时可省略目标。
<code>${p}fbi det @username</code>
<code>${p}fbi obs https://t.me/examplegroup @username</code>
回复用户消息后发送 <code>${p}fbi sur</code>，随后用 <code>${p}fbi ssv</code> 终止全部任务。

<b>缓存管理：</b>
• <code>${p}fbi cache</code> — 查看缓存群数、上限和重建状态
• <code>${p}fbi cache limit 数量</code> — 设置缓存群组上限，范围 10–1000，默认 300
• <code>${p}fbi cache rebuild</code> — 从账号可见对话中重建公开群缓存
• 示例：<code>${p}fbi cache limit 200</code>

<b>范围与任务行为：</b>
• 结果限于账号可访问且拥有公开用户名的群组或频道，以及当前缓存内容；缓存未命中表示尚未收录相关消息。
• 每群最多保留 3000 条、最近 30 天的消息；重建读取公开群组历史，范围受对话数量上限和账号可见历史限制；公开频道通过实时监听积累缓存。
• 每个目标同时保留一个蹲守任务，再次设置同一目标会替换原任务。
• 蹲守在命中一条消息后结束，通知发送到发起任务的对话和收藏夹。
• 任务和缓存持久保存；ssv 影响全部目标的蹲守。

<b>常见提示：</b>
• 无法识别目标：回复用户消息，或检查用户名/ID。
• 暂未发现消息：先查看 cache 状态，必要时 rebuild；重建不会扩大账号访问权限。

<code>${p}fbi</code>、<code>${p}fbi help</code> 或 <code>${p}help fbi</code> 查看本说明。`;
}
