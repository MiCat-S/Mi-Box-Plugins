import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `🧹 <b>清理工具 Pro</b>

<b>📝 功能概述:</b>
• <b>删除账号清理</b>: 扫描并清理已注销/删除的账号
• <b>拉黑用户清理</b>: 解除双向拉黑状态
• <b>被封禁实体解封</b>: 解封群组中被封禁的用户/频道/群组

<b>🔧 命令列表:</b>

<u>删除账号清理:</u>
• <code>${p}clean deleted pm</code> - 扫描私聊中的已注销账号
• <code>${p}clean deleted pm rm</code> - 扫描并删除已注销账号的私聊
• <code>${p}clean deleted member</code> - 扫描群组中的已注销账号
• <code>${p}clean deleted member rm</code> - 扫描并清理群组已注销账号

<u>拉黑用户清理:</u>
• <code>${p}clean blocked pm</code> - 清理拉黑用户（智能模式）
• <code>${p}clean blocked pm all</code> - 清理所有拉黑用户（全量模式）

<u>被封禁实体解封:</u>
• <code>${p}clean blocked member</code> - 解封自己封禁的实体
• <code>${p}clean blocked member all</code> - 解封所有被封禁的实体

<u>帮助信息:</u>
• <code>${p}clean help</code> - 查看本指南

<b>⚡ 智能清理模式:</b>
• 跳过机器人、诈骗账户、虚假账户
• 自动处理 API 限制
• 实时进度显示

<b>📊 数据统计:</b>
• 处理总数、成功数、失败数、跳过数
• 实体类型统计（用户/频道/群组）
• 清理成功率

<b>⚠️ 权限要求:</b>
• 群组操作需要管理员权限
• 封禁清理需要封禁用户权限
• 私聊清理仅操作当前账号的对话`;
}
