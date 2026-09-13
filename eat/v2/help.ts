import {ui} from "telebox/sdk";

export function renderHelp(prefix:string):string{const p=ui.text(prefix);return `表情包插件，首次使用自动下载配置和素材

• <code>${p}eat</code> / <code>${p}eat2</code> — 查看表情包列表
• <code>${p}eat set [配置URL]</code> — 强制更新配置
• 回复消息 + <code>${p}eat [名称]</code> — 使用对方头像生成
• 回复图片 + <code>${p}eat2 [名称]</code> — 使用回复媒体生成
• 回复消息后省略名称会随机选择表情包`;}
