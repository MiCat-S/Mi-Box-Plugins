import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🔥<b>Prometheus - 保存 Telegram 内容</b>

<blockquote>"To defy Power, which seems omnipotent."
—Percy Bysshe Shelley, Prometheus Unbound</blockquote>

<b>📝 功能:</b>
• 保存当前账号能够读取和下载的消息内容
• 支持批量处理多个消息链接
• 支持范围保存功能（自动保存指定范围内的所有消息）
• 支持来源显示功能
• 支持将媒体文件直接保存到本地 <code>assets/save/saved/</code> 目录
• 使用 <code>${p}save</code> 快速保存消息

<b>🔧 使用方法:</b>

<b>设置默认目标:</b>
• <code>${p}save to [目标]</code> - 设置默认转发目标(支持用户名、chatid如-123456780、'me'、'local')
• <code>${p}save to me</code> - 重置为发给自己
• <code>${p}save to local</code> - 将媒体保存到本地 <code>assets/save/saved/</code> 文件夹
• <code>${p}save target</code> - 查看当前目标

<b>来源显示控制:</b>
• <code>${p}save source on/off</code> - 开启/关闭来源显示功能
• <code>${p}save source</code> - 查看当前来源显示状态

<b>转发消息:</b>
• <code>${p}save</code> - 回复要转发的消息
• <code>${p}save [链接1] [链接2] ...</code> - 批量转发
• <code>${p}save [链接] [临时目标]</code> - 临时转发到指定对话
• <code>${p}save [链接] local</code> - 临时保存该媒体到本地
• <code>${p}save [链接1]|[链接2]</code> - 保存两个链接之间的所有消息（支持不连续编号，自动跳过不存在消息）

<b>💡 示例:</b>
• <code>${p}save to @group</code> - 设置默认目标
• <code>${p}save to -123456780</code> - 设置chatid为目标
• <code>${p}save to local</code> - 设置默认保存到本地
• <code>${p}save</code> - 回复消息进行转发
• <code>${p}save https://t.me/c/123/1 https://t.me/c/123/2</code> - 批量转发
• <code>${p}save https://t.me/c/123/1 @username</code> - 转发到指定用户
• <code>${p}save https://t.me/c/123/1 local</code> - 临时保存该媒体到本地
• <code>${p}save t.me/c/123/1|t.me/c/123/100</code> - 自动保存123群组/频道内1-100号消息

<b>📊 支持类型:</b>
• 文本、图片、视频、音频、语音
• 文档、贴纸、GIF动画
• 轮播相册、链接预览
• 投票、地理位置

<b>💾 本地模式说明:</b>
• 仅保存媒体文件，纯文本消息会自动跳过
• 文件保存到 <code>assets/save/saved/</code> 下的来源对话子目录
• 每个媒体文件旁会生成同名 <code>.json</code> 来源元数据`;
}
