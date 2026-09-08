import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `Nano-Banana 图像编辑插件

🎯 <b>Nano-Banana 图像编辑插件</b>
• 回复图片并附带 <code>${p}banana 提示词</code> 调用 Gemini Nano-Banana 修改图像
• <code>${p}banana key ＜密钥＞</code> 配置 Gemini API Key
• <code>${p}banana limit ＜数值/MB＞</code> 调整图片大小上限（默认 10MB，可用 default 重置）
• <code>${p}banana config</code> 查看配置
• <code>${p}banana limit</code> 查看当前大小上限
• <code>${p}banana limit default</code> 恢复默认上限

密钥仅可在收藏夹中设置；大小上限范围为 256KB 至 25MB。`;
}
