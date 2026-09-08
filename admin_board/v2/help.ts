import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return `👮 <b>管理员席位管理</b>

<b>排序简表</b>
• <code>${p}admin_board ls</code> - 查看当前对话管理员排序简表
• <code>${p}admin_board ls 对话id/@username</code>
• <code>${p}admin_board tail</code> - 查看未锁定席位的倒数 10 人
• <code>${p}admin_board tail 20</code> - 查看未锁定席位的倒数 20 人
• <code>${p}admin_board tail 20 对话id/@username</code>
• <code>${p}admin_board rm 3</code> - 一键下掉倒数 3 个未锁定席位管理员，人数参数必填
• <code>${p}admin_board rm 3 对话id/@username</code>

<b>席位锁定</b>
• <code>${p}admin_board lock @用户名/用户id [对话id/@username]</code> - 不传默认当前对话
• <code>${p}admin_board lock @u1,@u2 [对话id/@username]</code>
• <code>${p}admin_board unlock @用户名/用户id [对话id/@username]</code> - 不传默认当前对话
• <code>${p}admin_board unlock @u1，@u2 [对话id/@username]</code>

<b>缓存</b>
• <code>${p}admin_board clear</code> - 清当前对话的周日均/用户信息缓存
• <code>${p}admin_board clear 对话id/@username</code>

<b>ls 输出字段</b>
• 用户名 / 名称 / ID / 头衔 / 周日均 / 是否已锁定 / 娱乐文案

<b>说明</b>
• <code>ls</code> 是紧凑排行版，带娱乐文案
• <code>tail</code> 只列出未锁定席位的倒数 N 人，默认 <code>10</code>
• <code>rm</code> 只会下掉未锁定席位，且人数参数必填，必须是正整数
• <code>周日均</code> 和用户信息默认缓存 1 天
• 用户和对话都只支持 <code>@username</code> 或 <code>id</code>
• 多个用户请用英文逗号或中文逗号分隔`;
}
