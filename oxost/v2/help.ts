import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `文件上传到 0x0.st

🗂️ <b>0x0.st 文件上传插件</b>

<b>命令格式：</b>
<code>${p}0x0 [expires=小时] [secret]</code>

<b>用法：</b>
• 回复一条带文件/视频/语音的消息，自动上传到 <a href='https://0x0.st/'>0x0.st</a> 并返回下载链接
• <code>${p}0x0 expires=72 secret</code> 设置72小时有效期并启用难猜链接
• <code>${p}0x0 help</code> 显示帮助

<b>参数说明：</b>
• <code>expires=xx</code> 设置有效期（小时）
• <code>secret</code> 生成更难猜的链接`;
}
