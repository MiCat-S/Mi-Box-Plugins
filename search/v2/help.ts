import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `强大的多频道资源搜索插件，具备高级功能：

搜索功能:
- 关键词搜索: ${p}so &lt;关键词&gt; （不限制大小和时长）
- 随机速览: ${p}so kkp （随机选择20秒-3分钟的视频）

选项:
- 防剧透模式: -s (下载视频并将其作为防剧透消息发送)
- 随机模式: -r (从匹配结果中随机选择)

频道管理:
- 添加频道: ${p}so add &lt;频道链接&gt; (使用 \\ 分隔)
- 删除频道: ${p}so del &lt;频道链接|序号&gt; [...] 或 ${p}so del all (删除所有)
- 设置默认: ${p}so default &lt;频道链接&gt; 或 ${p}so default d (移除默认)
- 列出频道: ${p}so list
- 导出配置: ${p}so export
- 导入配置: ${p}so import (回复备份文件)

广告过滤:
- 添加关键词: ${p}so ad add &lt;关键词1&gt; &lt;关键词2&gt; ...
- 删除关键词: ${p}so ad del &lt;关键词1&gt; &lt;关键词2&gt; ...
- 查看关键词: ${p}so ad list

<b>命令别名：</b>
<code>${p}search</code> 与 <code>${p}so</code> 使用相同参数。`;
}
