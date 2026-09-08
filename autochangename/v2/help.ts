import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🤖 <b>自动昵称更新插件 v3</b>

让您的昵称动起来！自动显示时间或个性文案 ⏰

<b>📌 快速开始（按顺序执行）：</b>
1️⃣ <code>${p}acn save</code> - 保存当前昵称（首次使用必须）
2️⃣ <code>${p}acn on/off</code> - 开启或关闭自动更新
3️⃣ <code>${p}acn mode</code> - 切换显示模式
4️⃣ 等待一分钟，昵称会自动更新

<b>🔧 基础操作：</b>
<blockquote expandable>• <code>${p}acn save</code>
  保存/更新「原始昵称」基准（只改姓名，其它配置保留）
  保存后，插件会以此为基准，在每次更新时加上时间、文案等内容
  ⚠️ 建议在"干净"昵称下执行；已有 weather/style/order 等设置不会被清空
• <code>${p}acn on</code> / <code>off</code>
  开启或关闭自动昵称更新功能
  开启后每分钟自动更新一次，关闭后恢复已保存的原始昵称
• <code>${p}acn enable</code> / <code>disable</code>
  同上（别名命令）
• <code>${p}acn mode</code>
  循环切换显示模式：time → text → both → time
  • <code>time</code> - 只显示昵称 + 时间（如：张三 09:30）
  • <code>text</code> - 只显示昵称 + 文案（如：张三 摸鱼中）
  • <code>both</code> - 显示昵称 + 文案 + 时间（如：张三 摸鱼中 09:30）
• <code>${p}acn update</code> / <code>now</code>
  立即手动更新一次昵称，不等下一分钟
• <code>${p}acn reset</code>
  恢复原始昵称并停止自动更新（不删除配置）
• <code>${p}acn status</code>
  查看插件运行状态：自动更新是否运行、启用的用户数量</blockquote>
<b>🌍 时区管理：</b>
<blockquote expandable>• <code>${p}acn tz Asia/Shanghai</code>
  设置您的时区。参数为 IANA 时区标识符
  常用时区：Asia/Shanghai（北京）、America/New_York（纽约）、Europe/London（伦敦）等
• <code>${p}acn tz list</code>
  查看常用时区列表，方便复制使用
• <code>${p}acn tz on</code> / <code>off</code>
  控制昵称中是否显示时区信息（如 GMT+8）
  开启后昵称示例：张三 09:30 GMT+8
• <code>${p}acn tz format GMT</code>
  设置时区的显示格式，可选值：
  • <code>GMT</code> - 显示 GMT+8（默认）
  • <code>UTC</code> - 显示 UTC+8
  • <code>simp</code> - 显示时区缩写，如 HKT / CST / EDT
  • <code>offset</code> - 显示纯偏移量，如 +08:00
  • <code>custom:文字</code> - 自定义显示文字，如 custom:北京时间
• <code>${p}acn timezone</code>
  等同于 <code>${p}acn tz</code>（别名）</blockquote>
<b>🎨 外观设置：</b>
<blockquote expandable>• <code>${p}acn emoji on</code> / <code>off</code>
  开启或关闭时钟 emoji（🕐🕑🕒...）
  时钟 emoji 会根据当前小时自动匹配对应的钟面
• <code>${p}acn time on</code> / <code>off</code>
  开启或关闭时间显示
• <code>${p}acn text on</code> / <code>off</code>
  开启或关闭循环文案显示
• <code>${p}acn weather on</code> / <code>off</code>
  开启或关闭天气显示（需先设置地点）
• <code>${p}acn style italic</code>
  切换昵称中动态内容的文字样式
  可选：normal（默认）/ italic / double / sans / mono / outline
  样式效果示例：
  • normal: 123abc
  • italic: 𝟏𝟐𝟑𝐚𝐛𝐜
  • double: 𝟙𝟚𝟛𝕒𝕓𝕔
  • sans: 𝟭𝟮𝟯𝗮𝗯𝗰
  • mono: 𝟷𝟸𝟹𝚊𝚋𝚌
  • outline: 𝟣𝟤𝟥𝖺𝖻𝖼
• <code>${p}acn order</code>
  查看当前组件的显示顺序
• <code>${p}acn order name,text,time,weather,emoji</code>
  自定义昵称中各组件的排列顺序
  可用组件：name（昵称）、text（文案）、time（时间）、weather（天气）、emoji（时钟表情）、timezone（时区）</blockquote>
<b>📝 文案管理：</b>
<blockquote expandable>• <code>${p}acn text add 摸鱼中</code>
  添加一条循环文案。支持多行批量添加（每行一条）
  每条文案最长 50 字符，最多保存 100 条，建议简短有趣
  添加的文案会在 text/both 模式下按添加顺序循环显示
• <code>${p}acn text del 1</code>
  删除指定序号的文案（序号从 1 开始）
• <code>${p}acn text list</code>
  查看所有已添加的文案列表及序号
• <code>${p}acn text clear</code>
  清空所有文案</blockquote>
<b>🌤️ 天气显示：</b>
<blockquote expandable>• <code>${p}acn weather set 北京</code>
  设置天气地点并自动开启天气显示
  地点支持中文城市名或英文名（如 Beijing）
• <code>${p}acn weather on</code> / <code>off</code>
  手动开启或关闭天气显示（需先设置地点）
• <code>${p}acn weather</code>
  查看当前天气配置：地点、开关状态、预览
• 天气信息会缓存 30 分钟，避免频繁请求天气接口</blockquote>

<b>📊 查看配置：</b>
• <code>${p}acn status</code>
  查看插件运行状态（自动更新是否运行、启用用户数）
• <code>${p}acn config</code>
  查看您的完整配置状态，包括所有设置项的当前值

<b>💡 使用技巧：</b>
• 昵称每分钟自动更新一次，启用天气时，缓存每半小时刷新一次
• 文案会按添加顺序循环显示
• 被限流时会自动停用更新；等待限流结束后使用 <code>${p}acn on</code> 重新启用

<b>❓ 遇到问题？</b>
• 使用 <code>${p}acn status</code> 检查运行状态
• 使用 <code>${p}acn reset</code> 恢复原始昵称并停止自动更新
• 重新执行 <code>${p}acn save</code> 保存昵称

<b>命令别名：</b>
<code>${p}autochangename</code> 与 <code>${p}acn</code> 使用相同参数。`;
}
