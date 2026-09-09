import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `<b>封禁管理</b>
<code>${p}kick</code> 踢出 · <code>${p}ban</code> 封禁并清理消息
<code>${p}unban</code> 解封 · <code>${p}unmute</code> 解除禁言
<code>${p}mute [目标] [时长]</code> 禁言，时长如 60s / 5m / 1h / 1d；省略为永久
<code>${p}sb [目标]</code> 在所有有管理权的群/频道封禁，并清理当前群消息
<code>${p}unsb [目标]</code> 批量解封
<code>${p}refresh</code> 刷新管理群缓存
目标：回复消息 / @用户名 / 用户ID；管理员目标需追加 <code>true</code>。
基本群仅支持踢出；ban/sb 在基本群执行移出，不会阻止再次加入。

<b>命令别名：</b>
<code>${p}aban</code> - 查看封禁管理帮助`;
}
