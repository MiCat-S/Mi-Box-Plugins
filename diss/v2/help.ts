import {ui} from "telebox/sdk";

export function renderHelp(prefix: string): string {
  const p = ui.text(prefix);
  return [
    "🔫 <b>Diss · 嘴臭对线机</b>",
    "锁定目标后，TA 一说话就会被自动回怼。",
    "",
    "<b>锁定 / 解锁</b>",
    `<code>${p}diss @对方</code> 或回复对方消息发 <code>${p}diss</code>`,
    `<code>${p}undiss</code> 解锁目标`,
    `<code>${p}dislist</code> 查看本会话锁定`,
    `<code>${p}dissclear</code> 清空本会话锁定`,
    `<code>${p}dishelp</code> 查看本帮助`,
    "",
    "<b>其他</b>",
    `<code>${p}diss 语录</code> 获取一条祖安语录`,
    `<code>${p}dissai</code> 配置自动回怼使用的 AI 模型 / 提供商 / 思考强度`,
    "自动回怼使用 ai 插件的提供商，可单独指定模型；可能产生调用费用。AI 不可用时使用本地模板。",
  ].join("\n");
}
