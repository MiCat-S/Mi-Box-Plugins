import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `OpenList 管理

⚙️ <b>OpenList 管理插件</b>

<b>📝 功能描述:</b>
• 📦 <b>安装/管理</b>：一键安装、更新、卸载、修改端口
• 💾 <b>配置管理</b>：备份和恢复 OpenList 配置
• 🔑 <b>账户管理</b>：修改用户名和密码
• 📁 <b>文件保存</b>：快速保存文件到指定目录

<b>🔧 使用方法:</b>
• <code>${p}openlist install [目录]</code> - 安装
• <code>${p}openlist update</code> - 更新
• <code>${p}openlist uninstall</code> - 卸载
• <code>${p}openlist status</code> - 查看状态
• <code>${p}openlist setport [端口]</code> - 修改端口

• <code>${p}openlist backup</code> - 备份配置
• <code>${p}openlist restore [备份名]</code> - 恢复配置

• <code>${p}openlist admin setuser [用户名]</code>
• <code>${p}openlist admin setpass [密码]</code>
• <code>${p}openlist admin random</code>
• <code>${p}openlist login [用户] [密码]</code> - 手动配置账号信息
• <code>${p}openlist setdefault [路径]</code> - 设置默认保存路径 (不填则恢复默认)

• <code>${p}openlist save [路径]</code> - (回复文件) 保存到 Openlist 目录 (指定路径则上传到挂载盘)

<b>💡 示例:</b>
• <code>${p}openlist install /data/openlist</code>
• <code>${p}openlist setport 5255</code>

<b>命令别名：</b>
<code>${p}op</code> 是 <code>${p}openlist</code> 的别名。`;
}
