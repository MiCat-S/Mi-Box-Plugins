import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🍗 <b>NodeSeek 自动签到</b>

<b>用法：</b>
• <code>${p}nodeseek set &lt;cookie&gt;</code> 设置/更新登录 Cookie
• <code>${p}nodeseek now</code> 立即手动签到一次
• <code>${p}nodeseek status</code> 查看 Cookie 与签到状态
• <code>${p}nodeseek auto on</code> 开启每日自动签到（8:00~8:59 随机一次）
• <code>${p}nodeseek auto off</code> 关闭每日自动签到
• <code>${p}nodeseek help</code> 显示本帮助

<b>获取 Cookie：</b>
浏览器登录 nodeseek.com 后按 F12 打开开发者工具 → Network → 刷新页面 → 任意一个请求的 Request Headers 里复制完整的 Cookie 字段值。

<b>说明：</b>
签到逻辑参考 xinycai/nodeseek_signin，直接调用 NodeSeek 签到接口，无需账号密码登录。Cookie 仅保存在本机 assets/nodeseek/data.json 中。遇到 Cloudflare challenge 时会自动尝试 curl_cffi 浏览器指纹 fallback。插件不保存账号密码；Cookie 失效后请在浏览器重新登录并再次执行 <code>${p}nodeseek set &lt;cookie&gt;</code>。`;
}
