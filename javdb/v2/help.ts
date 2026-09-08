import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `JavDB 番号查询

🎬 <b>JavDB 番号查询</b>

<b>指令格式：</b>
<code>${p}javdb &lt;番号&gt;</code>
<code>${p}av &lt;番号&gt;</code>
<code>${p}jav &lt;番号&gt;</code>
<code>${p}jd &lt;番号&gt;</code>

<b>使用示例：</b>
<code>${p}av ABP-123</code>
<code>${p}javdb SSIS-001</code>
<code>${p}av start 128</code> （支持空格，自动转为 START-128）

<b>功能说明：</b>
• 查询 JavDB 数据库，获取番号详情
• 显示导演、系列、演员、标签等信息
• 封面图自动添加剧透标记，60秒后自动销毁
• 附带 JavDB 和 MissAV 在线观看链接`;
}
