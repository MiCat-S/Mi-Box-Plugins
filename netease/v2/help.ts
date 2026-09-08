import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `netease


依赖 @Music163bot

<code>${p}netease 关键词</code> 按关键词搜索并返回音频
<code>${p}netease 链接</code> 解析网易云链接并返回音频
<code>${p}netease ID</code> 通过歌曲ID返回音频

示例：
<code>${p}netease 晴天</code>
<code>${p}netease https://music.163.com/#/song?id=123456</code>
<code>${p}netease 123456</code>`;
}
