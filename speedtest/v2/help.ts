import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `⚡️ 网络速度测试工具 | SpeedTest by Ookla
<b>使用方法:</b>
<code>${p}speedtest</code> - 开始速度测试
<code>${p}speedtest [服务器ID]</code> - 使用指定服务器测试
<code>${p}speedtest list</code> - 显示可用服务器列表
<code>${p}speedtest test [服务器ID]</code> - 测试指定服务器可用性
<code>${p}speedtest best</code> - 查找最佳可用服务器
<code>${p}speedtest set [ID]</code> - 设置默认服务器
<code>${p}speedtest type photo/sticker/file/txt</code> - 设置优先使用的消息类型
<code>${p}speedtest clear</code> - 清除默认服务器
<code>${p}speedtest config</code> - 显示配置信息
<code>${p}speedtest check</code> - 检查网络连接状态
<code>${p}speedtest diagnose</code> - 诊断speedtest可执行文件问题
<code>${p}speedtest fix</code> - 自动修复speedtest安装问题
<code>${p}speedtest update</code> - 更新 Speedtest CLI

<b>系统speedtest支持:</b>
在任何测试命令中添加 <code>--system</code> 或 <code>-s</code> 标志使用系统已安装的speedtest
例: <code>${p}speedtest --system</code> 或 <code>${p}speedtest -s 12345</code>

<b>命令别名：</b>
<code>${p}st</code> 是 <code>${p}speedtest</code> 的别名。`;
}
