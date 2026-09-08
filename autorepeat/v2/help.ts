import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `<b>自动复读插件使用说明</b>

<b>指令列表：</b>
<code>${p}autorepeat on/off</code> - 在群组中使用，开启 / 关闭 当前群组
<code>${p}autorepeat on / off [群组ID / @群组名 / https://t.me/群组名]</code> - 开启指定群组
<code>${p}autorepeat allon</code> - 开启全部群组自动复读
<code>${p}autorepeat alloff</code> - 关闭全部群组自动复读
<code>${p}autorepeat list [页码]</code> - 查看已开启的群组(每页20个)
<code>${p}autorepeat set [时间] [人数]</code> - 自定义触发条件(如: ${p}autorepeat set 300 5)
<code>${p}autorepeat</code> - 查看当前群组状态

<b>高级用法：</b>
• 从目标群组转发消息后，回复该消息并使用 <code>${p}autorepeat on/off</code> 可切换该群组状态

<b>复读规则：</b>
• <b>触发条件</b>：默认5分钟内有5位不同用户发送完全相同的内容
• <b>每日限制</b>：同一群组内，相同内容每天只会自动复读一次 (UTC+8 0点重置)
• <b>忽略规则</b>：匿名消息、非文本消息、自己发送的消息、机器人消息会被忽略`;
}
