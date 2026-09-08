import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📌 消息模式插件


📌 <b>消息模式插件（支持 per-chat / 白名单 / 黑名单）</b>

🧭 查看当前会话模式
<code>${p}mode</code>

🎨 设置当前会话模式
<code>${p}mode del</code> 删除线
<code>${p}mode bold</code> 加粗
<code>${p}mode italic</code> 斜体
<code>${p}mode underline</code> 下划线
<code>${p}mode mask</code> 遮罩
<code>${p}mode all</code> 全格式
<code>${p}mode off</code> 关闭模式

————————————————————

📍 白名单（仅这些聊天启用）
<code>${p}mode whitelist add</code>
<code>${p}mode whitelist remove</code>
<code>${p}mode whitelist list</code>

📍 黑名单（这些聊天禁用）
<code>${p}mode blacklist add</code>
<code>${p}mode blacklist remove</code>
<code>${p}mode blacklist list</code>

⚠ 白名单优先级 > 黑名单 > per-chat 模式 > 全局模式

————————————————————

🌐 全局模式（默认应用于未设置模式的会话）
查看：
<code>${p}mode global</code>

设置：
<code>${p}mode global del</code>
<code>${p}mode global off</code>`;
}
