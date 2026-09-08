import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `⚙️ <b>Hitokoto 插件</b>

<b>📝 功能描述:</b>
• 从 hitokoto.cn API 获取随机一言
• 支持按句子类型筛选
• 包含详细的来源信息

<b>🔧 使用方法:</b>
• <code>${p}hitokoto</code> - 获取随机一言
• <code>${p}hitokoto a</code> - 只获取动画类一言
• <code>${p}hitokoto a c</code> - 从多个类型里随机获取

<b>📚 类型参数:</b>
• <code>a</code> 动画  • <code>b</code> 漫画  • <code>c</code> 游戏
• <code>d</code> 文学  • <code>e</code> 原创  • <code>f</code> 网络
• <code>g</code> 其他  • <code>h</code> 影视  • <code>i</code> 诗词
• <code>j</code> 网易云  • <code>k</code> 哲学  • <code>l</code> 抖机灵

<b>💡 参数说明:</b>
• 只接受类型字母参数
• 可同时传多个类型，如 <code>${p}hitokoto a c h</code>`;
}
