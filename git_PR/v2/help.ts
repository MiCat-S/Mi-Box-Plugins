import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `通过Git API管理PR

⚙️ <b>Git PR 管理插件</b>

<b>命令:</b>
• <code>${p}git login &lt;邮箱&gt; &lt;用户名&gt; &lt;Token&gt;</code> - 登录Git
• <code>${p}git repos</code> - 列出有编辑权限的仓库
• <code>${p}git prs &lt;仓库名&gt;</code> - 列出仓库的PR
• <code>${p}git merge &lt;仓库名&gt; &lt;PR编号&gt;</code> - 合并PR
• <code>${p}git mergeall &lt;仓库名&gt;</code> - 按序号合并所有可合并的PR
• <code>${p}git help</code> - 显示此帮助消息

<b>密钥配置：</b>
涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。`;
}
