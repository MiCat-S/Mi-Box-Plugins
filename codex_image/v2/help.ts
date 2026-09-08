import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `通过codex调用gpt-image-2

• <code>${p}cximg 提示词</code> 纯文本生成图片
• 回复图片并发送 <code>${p}cximg 提示词</code> 进行参考图生成
• <code>${p}cximg token 你的codex access token（通常在 .codex/auth.json）</code> 手动保存 Token`;
}
