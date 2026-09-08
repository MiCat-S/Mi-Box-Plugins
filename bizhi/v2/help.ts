import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `高品质壁纸


随机获取一张高品质壁纸

<code>${p}bizhi [分类] [-f]</code>
分类可选：meizi, dongman, fengjing, suiji
如 <code>${p}bizhi dongman</code>

✨ 优先从wallhaven.cc获取高品质原图（≥1920×1080）
🎨 优先内容：动漫、二次元、油画、摄影、日本风景、夜景
📐 只获取16:9宽高比壁纸，适配主流显示器
💾 文件大小≥3MB，确保高清画质
📊 显示分辨率和文件大小信息
📁 使用 -f 参数发送源文件而非图片`;
}
