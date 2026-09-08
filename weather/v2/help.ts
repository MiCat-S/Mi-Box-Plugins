import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🌤️ <b>天气查询插件</b>

<b>📝 功能描述:</b>
• 🌡️ <b>实时天气</b>：查询全球城市实时天气信息
• 🌍 <b>自动识别</b>：识别内置列表中的常用中文城市名
• 📊 <b>详细数据</b>：温度、湿度、风速、气压等
• 🌅 <b>日出日落</b>：显示当地日出日落时间
• 🔑 <b>免密钥查询</b>：使用 Open-Meteo API

<b>🔧 使用方法:</b>
• <code>${p}weather &lt;城市名&gt;</code> - 查询指定城市天气

<b>💡 使用示例:</b>
• <code>${p}weather 北京</code> - 查询北京天气
• <code>${p}weather beijing</code> - 使用英文查询
• <code>${p}weather New York</code> - 查询纽约天气
• <code>${p}weather 东京</code> - 查询东京天气

<b>🌐 支持格式:</b>
• 常用中文城市名：使用内置城市名对应表
• 英文城市名：直接查询
• 支持查询服务可识别的全球城市

<b>📌 注意事项:</b>
• 城市名不区分大小写
• 其他城市可使用英文名查询
• 数据来源：Open-Meteo（无需API密钥）`;
}
