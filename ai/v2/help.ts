import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `<blockquote expandable><b>🤖 智能 AI 助手</b>

<b>⚙️ API 配置:</b>
• <code>${p}ai config add tag url key [type]</code> - 添加 API 配置
• <code>${p}ai config del tag</code> - 删除 API 配置
• <code>${p}ai config type tag openai-compatible|openai|gemini|anthropic|codex|doubao|moonshot|local-cliproxy</code> - 设置 API 类型. 若不设置, 自动按 URL 特征自动识别
• <code>${p}ai config stream tag on|off</code> - 设置 API 流式传输
• <code>${p}ai config responses tag on|off</code> - 设置 chat/search 的 Responses 模式
• <code>type</code> 可选值: <code>openai-compatible/openai/gemini/anthropic/codex/doubao/moonshot/local-cliproxy</code>

<b>🧠 模型设置:</b>
• <code>${p}ai model chat tag model-path</code> - 设置聊天模型
• <code>${p}ai model search tag model-path</code> - 设置搜索模型
• <code>${p}ai model image tag model-path</code> - 设置图片模型
• <code>${p}ai model video tag model-path</code> - 设置视频模型
• <code>${p}ai reasoning chat auto|none|minimal|low|medium|high|xhigh</code> - 设置聊天思考强度
• <code>${p}ai reasoning search auto|none|minimal|low|medium|high|xhigh</code> - 设置搜索思考强度
• <code>${p}ai service chat auto|default|priority|fast|flex</code> - 设置聊天服务等级
• <code>${p}ai service search auto|default|priority|fast|flex</code> - 设置搜索服务等级

<b>💬 提问:</b>
• <code>${p}ai input</code> - 向 AI 发起提问
• <code>${p}ai search input</code> - 联网搜索并回答
• <code>${p}ai image prompt</code> - 文生/编辑图片
• <code>${p}ai video prompt</code> - 文生/参考图生成视频
• <code>${p}ai video first prompt</code> - 首帧生成视频
• <code>${p}ai video firstlast prompt</code> - 首尾帧生成视频

<b>✍️ 提示词:</b>
• <code>${p}ai prompt set input</code> - 设置提示词
• <code>${p}ai prompt del</code> - 删除提示词

<b>🧩 消息设置:</b>
• <code>${p}ai image preview on|off</code> - 开/关图片预览
• <code>${p}ai video preview on|off</code> - 开/关视频预览
• <code>${p}ai video audio on|off</code> - 开/关视频音频
• <code>${p}ai collapse on|off</code> - 开/关消息折叠
• <code>${p}ai video duration sec</code> - 视频输出时长
• <code>${p}ai timeout sec</code> - 设置超时时间

<b>📰 Telegraph:</b>
• <code>${p}ai telegraph on</code> - 开启 Telegraph
• <code>${p}ai telegraph off</code> - 关闭 Telegraph
• <code>${p}ai telegraph limit integer</code> - 设置容量
• <code>${p}ai telegraph del number/all</code> - 删除记录

<b>📌 使用说明:</b>
• 不携带参数可进行查询
• 回复消息可进行补充提问
</blockquote>

<b>密钥配置：</b>
涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。`;
}
