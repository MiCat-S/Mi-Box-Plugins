import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `从远程配置随机生成发电语录

🗒️ <b>发电语录插件</b>

<b>命令格式：</b>
<code>${p}fadian [子命令] [参数]</code>

<b>子命令：</b>
• <code>${p}fadian fd [名字]</code> - 心理语录（回复消息时自动获取对方昵称）
• <code>${p}fadian tg</code> - TG 语录
• <code>${p}fadian kfc</code> - KFC 语录
• <code>${p}fadian wyy</code> - 网抑云语录
• <code>${p}fadian cp</code> + 第二行/第三行为两个名字
• <code>${p}fadian clear</code> - 清理缓存并重新下载

<b>使用示例：</b>
<code>${p}fadian fd 张三</code> - 生成张三的心理语录
<code>${p}fadian fd</code> (回复消息) - 自动生成被回复人的心理语录
<code>${p}fadian cp</code>
第一个人
第二个人 - 生成CP语录`;
}
