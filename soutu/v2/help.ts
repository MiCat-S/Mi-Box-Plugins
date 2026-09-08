import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `回复图片进行搜图

🖼️ <b>搜图插件</b>

<b>命令格式：</b>
<code>${p}soutu</code> - 回复一张图片并使用此命令

<b>功能:</b>
回复一张图片并发送 <code>${p}soutu</code> 命令，插件会自动将其上传到临时图床 (0x0.st) 并生成 Google 和 Yandex 的搜图链接。
文件默认有效期约为30天。

<b>命令:</b>
• <code>${p}soutu</code> - 搜索图片（需要回复图片）
• <code>${p}soutu help</code> - 显示此帮助消息`;
}
