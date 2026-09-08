import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `DuckDuckGo 搜索（TLS 伪装 + Firecrawl 回退）

🔍 <b>DuckDuckGo 搜索</b>

<b>用法：</b>
• <code>${p}ddg &lt;关键词&gt;</code>
• <code>${p}duckduckgo &lt;关键词&gt;</code>
• <code>${p}ddg &lt;关键词&gt; -n 5</code> — 条数 1–15

<b>链路（自动）：</b>
1. DuckDuckGo HTML（Chrome TLS 伪装）
2. Firecrawl 免 Key 搜索（结果不足时）

<b>首次使用：</b>自动初始化 <code>assets/duckduckgo/</code> 与 curl_cffi`;
}
