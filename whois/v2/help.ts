import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🔍 <b>WHOIS 域名查询</b>

<b>📝 功能：</b>
• 查询域名注册信息和状态
• 显示注册/过期/更新日期
• 查看DNS服务器和注册商
• 批量查询多个域名
• 查询历史记录缓存
• 域名到期提醒

<b>🔧 使用：</b>
• <code>${p}whois &lt;域名&gt;</code> - 查询指定域名
• <code>${p}whois</code> - 回复包含域名的消息
• <code>${p}whois batch &lt;域名1&gt; &lt;域名2&gt;...</code> - 批量查询
• <code>${p}whois history</code> - 查看查询历史
• <code>${p}whois clear</code> - 清除历史记录

<b>💡 示例：</b>
• <code>${p}whois google.com</code>
• <code>${p}whois batch google.com github.com</code>

<b>📌 说明：</b>
• 支持自动提取URL中的域名
• 支持回复消息中的域名提取
• 查询结果自动缓存24小时
• 支持批量查询（最多10个）
• 自动检测即将过期的域名`;
}
