import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return [
    "🔫 <b>Diss · 嘴臭对线机</b>",
    "锁定目标后，TA 一说话就会被自动回怼。",
    "",
    "<b>锁定 / 解锁</b>",
    `<code>${p}diss @对方</code> 艾特锁定`,
    `<code>${p}diss</code> 回复对方消息锁定`,
    `<code>${p}undiss @对方</code> 解锁（也可回复对方消息发 <code>${p}undiss</code>）`,
    `<code>${p}dislist</code> 查看本会话锁定列表`,
    `<code>${p}dissclear</code> 清空本会话锁定`,
    `<code>${p}dishelp</code> 查看本帮助`,
    "",
    "<b>其他</b>",
    `<code>${p}diss 语录</code> 获取一条祖安语录`,
    "",
    "<b>AI 配置（.dissai）</b>",
    "自动回怼默认复用 ai 插件的聊天提供商，可单独覆盖：",
    `<code>${p}dissai</code> 查看当前设置与 ai 实际使用的模型`,
    `<code>${p}dissai model 模型名</code> 指定 diss 使用的模型`,
    `<code>${p}dissai provider tag</code> 指定用 ai 配置里的哪个提供商`,
    `<code>${p}dissai reasoning 级别</code> 思考强度，可选 auto | none | minimal | low | medium | high | xhigh`,
    `<code>${p}dissai model reset</code> 恢复跟随 ai 插件（provider / reasoning 同理）`,
    "只设模型不设 provider 时，沿用 ai 当前聊天提供商的 URL/Key。",
    "可能产生调用费用；AI 不可用时使用本地模板。",
  ].join("\n");
}
