import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🗞️ <b>每日新闻插件</b>

<b>📝 功能描述:</b>
• 📰 <b>每日新闻</b>：获取当日热点新闻
• 🎬 <b>历史上的今天</b>：查看历史事件
• 🧩 <b>天天成语</b>：学习成语知识
• 🎻 <b>慧语香风</b>：欣赏名人名言
• 🎑 <b>诗歌天地</b>：品味古典诗词

<b>🔧 使用方法:</b>
• <code>${p}news</code> - 获取完整的每日资讯

<b>💡 示例:</b>
• <code>${p}news</code> - 获取今日完整资讯包

<b>📊 数据来源:</b>
• API: news.topurl.cn
• 内容: 新闻、历史、成语、名言、诗词`;
}
