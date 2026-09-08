import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `多音源音乐搜索

依赖 @music_v1bot, @vkmusic_bot, @ttaudiobot

<code>${p}mbvk 关键词</code>, <code>${p}music_bot vk 关键词</code> 使用 @vkmusic_bot 音乐源搜索

<code>${p}mbym 关键词</code>, <code>${p}music_bot ym 关键词</code> 用 YouTube Music 源搜索

<code>${p}mbs 关键词</code>, <code>${p}music_bot search 关键词</code> 使用 @music_v1bot 搜索音乐，关键词中包含搜索源会自动识别 例如：<code>search 洛天依 网易云</code>
<code>${p}mbkg 关键词</code>, <code>${p}music_bot kugou 关键词</code> 用酷狗源搜索
<code>${p}mbkw 关键词</code>, <code>${p}music_bot kuwo 关键词</code> 用酷我源搜索
<code>${p}mbqq 关键词</code>, <code>${p}music_bot qq 关键词</code> 用 QQ 音乐源搜索
<code>${p}mbne 关键词</code>, <code>${p}music_bot netease 关键词</code> 用网易云音乐源搜索`;
}
