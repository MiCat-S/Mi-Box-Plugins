import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `自动回应消息。

🎯 <b>自动回应插件 (Trace)</b>
━━━━━━━━━━━━━━━━
<i>通过自动发送 Reactions 来追踪特定用户或关键字消息</i>

📌 <b>用户追踪</b>
├ 💬 回复消息 + <code>${p}trace 👍👎🥰</code>
│  └ 使用指定表情追踪该用户
└ 🚫 回复消息 + <code>${p}trace</code>
   └ 取消追踪该用户

🔍 <b>关键字追踪</b>
├ ➕ <code>${p}trace kw add &lt;词&gt; 👍👎🥰</code>
│  └ 添加关键字自动回应
└ ➖ <code>${p}trace kw del &lt;词&gt;</code>
   └ 删除关键字追踪

📊 <b>管理命令</b>
├ 📈 <code>${p}trace status</code> - 查看追踪统计
├ 🗑️ <code>${p}trace clean</code> - 清除所有追踪
└ ⚠️ <code>${p}trace reset</code> - 重置全部数据

⚙️ <b>配置选项</b>
├ 📝 <code>${p}trace log [true|false]</code>
│  └ 操作回执保留 (默认: true)
└ 🎭 <code>${p}trace big [true|false]</code>
   └ 大号表情动画 (默认: true)

💡 <b>使用提示</b>
• 标准表情无需 Premium
• 自定义表情需要 Premium 订阅
• 可用表情: <code>👍👎❤️🔥🥰👏😁🤔🤯😱🤬😢🎉🤩🤮💩🙏👌🕊🤡🥱🥴😍🐳❤️‍🔥🌚🌭💯🤣⚡️🍌🏆💔🤨😐🍓🍾💋🖕😈😎😇😤🏻‍💻</code>`;
}
