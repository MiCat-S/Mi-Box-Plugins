import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `FBI 跨群组追踪

🕵️ <b>FBI 跨群组追踪</b>

• <code>${p}fbi det（detect） [目标]</code> — 现场勘察（搜索目标最新消息）
• <code>${p}fbi sur（surveil） [目标]</code> — 监视追踪（蹲守目标下一条消息）
• <code>${p}fbi obs（observation） [目标]</code> — 定点监视（蹲守指定群组内目标下一条消息）
• <code>${p}fbi loc（locate） [目标]</code> — 窝点锁定（分析目标最活跃群组）
• <code>${p}fbi ssv</code> — 终止所有蹲守
• <code>${p}fbi cache</code> — 查看/管理消息缓存
• <code>${p}fbi help</code> — 本帮助

目标可为 @用户名、用户ID，或回复消息自动取被回复者。

<b>缓存管理：</b>
• <code>${p}fbi cache limit 200</code> - 设置缓存群组上限，范围 10–1000
• <code>${p}fbi cache rebuild</code> - 重建公开群缓存`;
}
