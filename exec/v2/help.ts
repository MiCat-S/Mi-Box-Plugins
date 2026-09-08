import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🖥️ <b>系统命令执行</b>

系统命令由主程序内置的 <code>exec</code> 提供。

• <code>${p}help exec</code> - 查看命令格式、权限与执行限制
• 执行身份与进程限制使用主程序配置`;
}
