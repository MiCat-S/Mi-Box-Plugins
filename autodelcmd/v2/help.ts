import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🗑️ 自动删除命令消息插件

<b>功能说明:</b>
- 自动监听并延迟删除特定命令的消息
- 支持所有配置的自定义前缀和别名命令
- 支持自定义删除规则和延迟时间
- 首次运行自动创建配置文件，包含预设的默认规则

<b>消息处理范围:</b>
- 自己发出的所有命令消息
- Saved Messages（收藏夹）中的命令消息

<b>配置管理命令:</b>
• <code>${p}autodelcmd on/off</code> - 启用/禁用自动删除功能
• <code>${p}autodelcmd status</code> - 查看功能状态和规则统计
• <code>${p}autodelcmd list</code> - 查看所有规则
• <code>${p}autodelcmd add [命令] [延迟秒数] [参数1] [参数2] [...] [-r] [-e]</code> - 添加规则
• <code>${p}autodelcmd del [规则ID或命令名]</code> - 删除规则或查看规则
• <code>${p}autodelcmd reset</code> - 重置为默认配置

<b>特殊选项:</b>
• 🔄 使用 <code>-r</code> 或 <code>--response</code> 参数启用删除响应消息
• 删除响应指同时删除命令触发的最近一条回复消息
• 🎯 使用 <code>-e</code> 或 <code>--exact</code> 参数启用精确匹配模式
• 精确匹配只匹配无参数的命令调用，不匹配带参数的调用

<b>使用示例:</b>
• <code>${p}autodelcmd list</code> - 查看所有配置规则
• <code>${p}autodelcmd add ping 30</code> - ping命令30秒后删除
• <code>${p}autodelcmd add speedtest 60 -r</code> - speedtest命令60秒后删除（🔄包含响应）
• <code>${p}autodelcmd add tpm 60 list ls search</code> - tpm list/ls/search任一命令60秒后删除
• <code>${p}autodelcmd add ping 30 -e</code> - 只有无参数的ping命令30秒后删除
• <code>${p}autodelcmd del ping</code> - 查看ping命令的所有规则
• <code>${p}autodelcmd del 1</code> - 使用ID删除指定规则
• <code>${p}autodelcmd reset</code> - 重置为默认配置

<b>配置文件位置:</b>
规则通过上述命令管理，并持久保存在插件配置中。

<b>注意:</b> 插件默认处于禁用状态，需要手动启用才能工作。首次运行会自动创建配置文件并写入默认规则。`;
}
