import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `isalive

<code>${p}isalive 用户名/UID</code> - 活了么

可配置 <code>acron</code> 实现定时在某个群里查询某个用户活了么

<pre>${p}acron cmd 0 0 12 * * * -1002514991425 定时在花火喵查询亚托莉活了么
${p}isalive 1948276144</pre>

使用 UID 时, 需要满足一些条件 比如有过私聊之类的 目前本脚本会自动获取对话 所以私聊过的可以查到
https://docs.telethon.dev/en/stable/concepts/entities.html`;
}
