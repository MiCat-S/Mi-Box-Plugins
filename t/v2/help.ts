import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🚀 <b>文字转语音/音乐插件</b>
• <code>${p}t 文本</code> - 普通语音（发送后自动删命令）
• <code>${p}t 歌曲名 歌手 [专辑名] 文本</code> - 音乐模式（发送后自动删命令）
• <code>${p}t fm 封面链接</code> - 设置当前角色封面
• <code>${p}ts [页码]</code> - 分页查看角色列表（默认每页 20）
• <code>${p}ts 角色名</code> - 切换角色
• <code>${p}ts 角色名 角色ID</code> - 新增/更新并切换为默认
• <code>${p}tk APIKey</code> - 设置 API Key
• 第一次需要申请 Fish API Key: https://fish.audio/
• 更多角色选择请查看: https://fish.audio/zh-CN/app/discovery/

<b>密钥配置：</b>
涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。`;
}
