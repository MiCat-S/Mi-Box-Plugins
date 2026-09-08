import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `自定义 Prompt 的 AI 转写插件：
- ${p}aitc url ＜地址＞ - 自定义API地址（兼容OpenAI SDK，默认OpenAI）
- ${p}aitc key ＜API Key＞ - 设置API Key
- ${p}aitc model ＜模型名＞ - 指定模型（默认gpt-4o-mini）
- ${p}aitc temp ＜0-2＞ - 调整模型温度（默认0.2）
- ${p}aitc prompt ＜默认Prompt＞ - 设置默认Prompt（默认转写为英文）
- ${p}aitc spn ＜Prompt简称＞ ＜Prompt内容＞ - 保存或更新Prompt预设
- ${p}aitc ＜Prompt简称＞ [文本] - 使用预设Prompt处理文本
- ${p}aitc [文本] - 使用默认Prompt处理文本
- ${p}aitc info - 查看当前配置

<b>密钥配置：</b>
涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。`;
}
