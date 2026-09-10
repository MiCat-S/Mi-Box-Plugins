import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🎨 <b>Codex 图片生成</b>

通过 Codex 图片工具生成图片，也可回复一张图片提供参考。

<b>首次配置：</b>
在收藏夹执行 <code>${p}cximg token AccessToken</code>，保存有效的 Codex Access Token。
示例：<code>${p}cximg token your_access_token</code>
密钥也可通过插件设置中的 Access Token 字段保存。

<b>使用：</b>
• <code>${p}cximg 提示词</code> — 根据文字生成图片
• 回复图片后发送 <code>${p}cximg 提示词</code> — 将该图片作为参考，按提示词生成结果

<b>示例：</b>
<code>${p}cximg 一只坐在窗边的橘猫，水彩插画</code>
回复图片后发送 <code>${p}cximg 保留主体，把背景改成海边</code>。

<b>插件设置：</b>
• Access Token：用于连接 Codex 服务，过期后重新保存有效值
• 模型：调用 Codex 图片工具的模型名称，默认 gpt-5.4
• 最大等待时间：单位毫秒，默认 600000（10 分钟），范围 60000–1800000（1–30 分钟）；流式请求和后续轮询分别受该时间窗口约束

<b>媒体与结果：</b>
• 参考图需为图片媒体或图片文件，单张下载上限 20 MiB。
• 生成图片上限 32 MiB，结果以 PNG 文件名发送到当前对话，并附提示词。
• 使用参考图时结果回复参考消息；成功发送后会删除生成命令。
• 提示词和参考图会发送到配置所连接的 Codex 服务。

<b>常见提示：</b>
• 未配置 Token：先在收藏夹完成 token 设置。
• 生成失败：检查凭据有效性、模型是否支持图片工具、网络和参考图格式/大小。

<code>${p}cximg help</code> / <code>${p}help codex_image</code> 查看本说明。`;
}
