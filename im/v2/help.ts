import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `<b>🖼️ 图片监控插件 (image_monitor)</b>

自动监控指定群组的图片，并对匹配MD5哈希的图片执行操作。

<b>命令格式:</b>
<code>${p}im [子命令] [参数]</code>

<b>子命令:</b>
• <code>${p}im on</code> - 启用插件
• <code>${p}im off</code> - 禁用插件
• <code>${p}im addchat [chatId|@username]</code> - 添加监控群组 (默认为当前群组)
• <code>${p}im delchat [chatId|@username]</code> - 删除监控群组 (默认为当前群组)
• <code>${p}im addmd5 &lt;md5&gt; &lt;delete|ban&gt;</code> - 添加MD5及操作
• <code>${p}im delmd5 &lt;md5&gt;</code> - 删除MD5
• <code>${p}im setaction &lt;delete|ban&gt;</code> - 设置回复时的默认操作
• <code>${p}im list</code> - 查看当前配置
• <code>${p}im help</code> - 显示此帮助

<b>快速操作:</b>
• 回复图片/媒体/贴纸使用 <code>${p}im [delete|ban]</code> - 快速添加（图片MD5/文件MD5/贴纸ID），未指定时使用默认操作`;
}
