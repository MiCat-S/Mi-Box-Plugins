import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `随机纸片人插件

🎨 <b>随机纸片人插件</b>

<b>命令格式：</b>
<code>${p}zpr [参数]</code>

<b>可选参数：</b>
• <code>${p}zpr</code> - 随机获取1张纸片人图片
• <code>${p}zpr [数量]</code> - 获取指定数量图片（1-10）
• <code>${p}zpr [标签]</code> - 按标签筛选图片
• <code>${p}zpr [标签] [数量]</code> - 按标签获取指定数量
• <code>${p}zpr r18</code> - 获取R18内容
• <code>${p}zpr r18 [数量]</code> - 获取指定数量R18图片
• <code>${p}zpr proxy</code> - 查看当前反代设置
• <code>${p}zpr proxy [地址]</code> - 设置反代地址

<b>使用示例：</b>
<code>${p}zpr</code> - 随机1张
<code>${p}zpr 3</code> - 随机3张
<code>${p}zpr 风景</code> - 风景标签
<code>${p}zpr 风景 2</code> - 风景标签2张

<b>反代地址管理：</b>
<code>${p}zpr proxy</code> - 查看当前反代
<code>${p}zpr proxy i.pximg.net</code> - 设置为pximg.net
<code>${p}zpr proxy i.pixiv.cat</code> - 设置为pixiv.cat
<code>${p}zpr proxy i.pixiv.re</code> - 设置为pixiv.re
<code>${p}zpr proxy i.pixiv.nl</code> - 设置为pixiv.nl

<b>说明：</b>
• 图片来源：Lolicon API
• 数量限制：1-10张
• 默认反代：i.pximg.net（官方图片服务器，优先推荐）`;
}
