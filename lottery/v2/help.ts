import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🎰 <b>智能抽奖插件 - 完整功能指南</b>

🎯 <b>抽奖管理:</b>
• <code>${p}lottery create [标题] [关键词] [人数] [中奖数] [仓库名]</code> - 创建抽奖活动
  <b>参数说明：</b>
  · <b>标题</b> - 抽奖活动名称（支持中文、英文、表情）
  · <b>关键词</b> - 用户参与抽奖需要发送的文字（建议简短易记）
  · <b>人数</b> - 参与人数上限（达到后自动开奖，数字）
  · <b>中奖数</b> - 中奖名额数量（不能大于参与人数，数字）
  · <b>仓库名</b> - 奖品仓库名称（需先创建仓库并添加奖品）
  · <b>通知</b>（可选） - 置顶时是否通知，添加 notify 参数会发送通知
• <code>${p}lottery create list</code> - 查看可用奖品仓库列表
• <code>${p}lottery draw</code> - 手动开奖（创建者）
• <code>${p}lottery status</code> - 查看当前抽奖状态
• <code>${p}lottery list</code> - 查看参与用户列表
• <code>${p}lottery delete</code> - 强制删除抽奖活动（创建者）

⚠️ <b>重要提示:</b>
• 开奖后原抽奖消息会被自动删除
• 开奖结果消息不会自动置顶，如需置顶请手动操作
• 创建抽奖前必须先创建奖品仓库并添加奖品

🎁 <b>奖品仓库管理（仅私聊）:</b>
• <code>${p}lottery prize create [仓库名]</code> - 创建新的奖品仓库
• <code>${p}lottery prize add [仓库名] [奖品内容] [数量]</code> - 添加奖品到仓库
• <code>${p}lottery prize list [仓库名]</code> - 查看指定仓库奖品列表
• <code>${p}lottery prize clear [仓库名]</code> - 清空指定仓库
• <code>${p}lottery prize clear all</code> - 清空所有仓库

📊 <b>中奖管理:</b>
• <code>${p}lottery winners</code> - 查看中奖名单和领奖状态
• <code>${p}lottery claim [用户ID/@用户名]</code> - 手动标记用户已领奖
• <code>${p}lottery expire</code> - 处理过期未领取的奖品

⚙️ <b>参与规则:</b>
• 默认排除机器人账号
• 每人每场抽奖仅参与一次
• 群内准确发送活动关键词即可参与

🔧 <b>系统特性:</b>
• 自动奖品分发 - 开奖后自动发送私聊消息通知中奖者
• 库存管理 - 奖品仓库支持库存追踪和自动消耗
• 并发安全 - 奖品扣减与中奖记录一并持久化
• 过期处理 - 使用 expire 命令处理超过24小时仍未完成通知的奖品记录
• 权限控制 - 奖品管理仅限私聊，保护敏感操作
• 消息管理 - 开奖时自动删除原抽奖消息，保持群组整洁

💡 <b>使用示例:</b>

<b>创建抽奖（完整流程）:</b>
1️⃣ 首先创建奖品仓库：
<code>${p}lottery prize create myprizes</code>

2️⃣ 添加奖品到仓库：
<code>${p}lottery prize add myprizes "iPhone 15 Pro" 1</code>
<code>${p}lottery prize add myprizes "现金红包100元" 5</code>

3️⃣ 查看可用仓库：
<code>${p}lottery create list</code>

4️⃣ 创建抽奖活动：
<code>${p}lottery create 新年抽奖 抽奖 100 5 myprizes</code>
  · 活动名称：新年抽奖
  · 参与关键词：抽奖
  · 参与人数上限：100人
  · 中奖名额：5个
  · 使用仓库：myprizes

<b>带通知的创建（置顶时会通知所有人）:</b>
<code>${p}lottery create 新年抽奖 抽奖 100 5 myprizes notify</code>

<b>其他创建示例:</b>
<code>${p}lottery create iPhone大奖 888 50 1 myprizes</code> - 使用 myprizes 仓库
<code>${p}lottery create 红包雨 💰 200 20 cash</code> - 关键词可以是表情

<b>奖品管理（必须在私聊中操作）:</b>
<code>${p}lottery prize create [仓库名]</code> - 创建奖品仓库
<code>${p}lottery prize add [仓库名] [奖品描述] [数量]</code> - 添加奖品
<code>${p}lottery prize list [仓库名]</code> - 查看仓库奖品
<code>${p}lottery prize clear [仓库名]</code> - 清空指定仓库
<code>${p}lottery prize clear all</code> - 清空所有仓库

<b>奖品管理示例:</b>
<code>${p}lottery prize create vip</code> - 创建VIP仓库
<code>${p}lottery prize add vip "VIP会员1个月" 10</code> - 添加10个月卡
<code>${p}lottery prize add vip "VIP会员1年" 1</code> - 添加1个年卡
<code>${p}lottery prize list vip</code> - 查看VIP仓库内容

<b>状态查询:</b>
<code>${p}lottery status</code> - 查看进度
<code>${p}lottery winners</code> - 查看中奖情况
<code>${p}lottery claim @username</code> - 标记用户已领奖
<code>${p}lottery delete</code> - 强制删除抽奖活动

🎮 <b>参与方式:</b>
用户在群组中发送抽奖关键词即可参与，达到人数上限自动开奖，中奖者将收到私聊通知。

📝 <b>注意事项:</b>
• 每个群组同时只能有一个进行中的抽奖活动
• 参与关键词区分大小写，请准确发送
• 每个用户只能参与一次，重复发送无效
• 达到人数上限会立即自动开奖
• 创建者可使用 <code>${p}lottery draw</code> 提前手动开奖`;
}
