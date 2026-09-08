import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `哪吒监控插件：
- ${p}nezha - 查看所有服务器状态
- ${p}nezha set [地址] [Secret/配置文件路径] - 配置哪吒面板
- ${p}nezha service on/off - 开启/关闭服务监控显示
- ${p}nezha chart [服务器名/ID] - 查看服务监控延迟图表

支持直接填写 jwt_secret_key 或 config.yaml 路径自动读取

<b>密钥配置：</b>
涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。`;
}
