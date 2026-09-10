import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `📚 <b>DeepWiki 项目问答</b>

管理项目标签，基于 DeepWiki 已索引的 GitHub 项目提问，并按需保存多轮上下文。

<b>项目管理：</b>
• <code>${p}deepwiki add 标签 项目URL</code> — 添加或更新项目，并将其设为当前项目
• <code>${p}deepwiki lst</code> — 查看当前对话的项目列表
• <code>${p}deepwiki use 标签</code> — 切换当前项目
• <code>${p}deepwiki del 标签</code> — 删除项目及其上下文；删除当前项目后需重新选择项目

<b>提问：</b>
• <code>${p}deepwiki 你的问题</code> — 向当前项目提问
• <code>${p}deepwiki 标签 你的问题</code> — 为本次提问指定项目
• 回复文字消息后提问，会将引用文字一并提交

<b>上下文管理：</b>
• <code>${p}deepwiki ctx</code> — 查看上下文开关与当前项目
• <code>${p}deepwiki ctx on</code> / <code>${p}deepwiki ctx off</code> — 开启或关闭，默认关闭
• <code>${p}deepwiki ctx del</code> — 清空当前项目上下文
• <code>${p}deepwiki ctx del 标签</code> — 清空指定项目上下文
• <code>${p}deepwiki ctx del all</code> — 清空当前对话范围内全部项目上下文

<b>完整示例：</b>
1. <code>${p}deepwiki add node https://github.com/nodejs/node</code>
2. <code>${p}deepwiki node 事件循环如何工作？</code>
3. <code>${p}deepwiki ctx on</code>
4. <code>${p}deepwiki 相关源码主要在哪些目录？</code>
5. <code>${p}deepwiki ctx del node</code>

<b>参数与保存范围：</b>
• 标签为 1–40 位字母、数字、下划线、点或连字符；按原标签匹配。
• URL 支持 github.com 或 deepwiki.com 的项目地址；项目需要已被 DeepWiki 索引。
• 项目、当前选择和上下文按对话保存，论坛话题分别保存；每个项目最多保留最近 50 轮。
• 关闭上下文后暂停使用和记录历史，已有历史保留；需要清空时使用 ctx del。
• 请求文本包括本次问题、引用文字及启用的历史，上限 48000 字符，超出时保留末尾内容。

<b>常见提示：</b>
操作失败时先用 lst 和 ctx 核对项目、标签与开关，再检查项目在 DeepWiki 上是否可用。长回答会分多条消息显示。

<code>${p}deepwiki</code>、<code>${p}deepwiki help</code> 或 <code>${p}help deepwiki</code> 查看本说明。`;
}
