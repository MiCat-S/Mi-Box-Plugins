import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type PluginContext} from "telebox/sdk";

type Config = {apiKey: string; apiUrl: string; model: string; prompt: string; prompts: Record<string, string>; temperature: number; aiMigrated?: boolean};
const defaults: Config = {
  apiKey: "",
  apiUrl: "",
  model: "",
  prompt: "Translate the user's Chinese text into natural colloquial English. Preserve meaning and tone. Output only the translation.",
  prompts: {},
  temperature: 0.2, aiMigrated: true,
};
const RESERVED = new Set(["apikey", "key", "api", "url", "model", "prompt", "temp", "temperature", "info", "spn"]);
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);
function store(context: PluginContext) { return context.storage.json<Config>("config.json", defaults); }
function endpoint(base: string): URL {
  const value = new URL(base);
  if (!/^https?:$/.test(value.protocol) || value.username || value.password) throw new Error("Invalid API URL");
  value.pathname = `${value.pathname.replace(/\/+$/, "")}/v1/chat/completions`;
  value.search = ""; value.hash = "";
  return value;
}
async function migrateAi(context: PluginContext): Promise<void> {
  const current = await store(context).read();
  if (current.aiMigrated) return;
  if (!current.apiKey) {
    await store(context).update(value => ({...value, apiUrl: "", model: "", aiMigrated: true}));
    return;
  }
  if (!context.services.available("ai", "import_provider")) return;
  let target: URL;
  try { target = endpoint(current.apiUrl); } catch { return; }
  if (!current.model.trim()) return;
  target.pathname = target.pathname.replace(/\/chat\/completions$/, "");
  await context.services.call("ai", "import_provider", {tag: "aitc", url: target.toString(), key: current.apiKey,
    type: "openai-compatible", models: {chat: current.model}, select: ["chat"]}, context.signal);
  await store(context).update(value => ({...value, apiKey: "", apiUrl: "", model: "", aiMigrated: true}));
}
function validateConfig(current: Config, patch: Record<string, unknown>): Config {
  const next: Config = {...current, prompts: {...current.prompts}};
  if (patch.apiKey !== undefined) {
    if (typeof patch.apiKey !== "string" || patch.apiKey.length > 4096) throw new Error("Invalid key");
    next.apiKey = patch.apiKey.trim();
  }
  if (patch.apiUrl !== undefined) {
    if (typeof patch.apiUrl !== "string" || patch.apiUrl.length > 2048) throw new Error("Invalid URL");
    endpoint(patch.apiUrl);
    next.apiUrl = patch.apiUrl.replace(/\/+$/, "");
  }
  if (patch.model !== undefined) {
    if (typeof patch.model !== "string" || !patch.model.trim() || patch.model.length > 200) throw new Error("Invalid model");
    next.model = patch.model.trim();
  }
  if (patch.prompt !== undefined) {
    if (typeof patch.prompt !== "string" || !patch.prompt.trim() || patch.prompt.length > 20_000) throw new Error("Invalid prompt");
    next.prompt = patch.prompt;
  }
  if (patch.temperature !== undefined) {
    if (typeof patch.temperature !== "number" || !Number.isFinite(patch.temperature) || patch.temperature < 0 || patch.temperature > 2) throw new Error("Invalid temperature");
    next.temperature = patch.temperature;
  }
  if (patch.prompts !== undefined) {
    if (!patch.prompts || typeof patch.prompts !== "object" || Array.isArray(patch.prompts)) throw new Error("Invalid prompts");
    const prompts: Record<string, string> = {};
    for (const [name, value] of Object.entries(patch.prompts)) {
      if (!/^[a-z0-9_-]{1,32}$/.test(name) || RESERVED.has(name) || typeof value !== "string" || !value.trim() || value.length > 20_000) throw new Error("Invalid prompts");
      prompts[name] = value;
    }
    next.prompts = prompts;
  }
  return next;
}

export default function createAitc() {
  const edit = (context: PluginContext, invocation: CommandInvocation, text: string, html = true) =>
    context.telegram.edit(invocation.message, text, html ? {parseMode: "html", linkPreview: false} : {linkPreview: false});
  const guard = (run: (invocation: CommandInvocation, context: PluginContext) => Promise<void>) =>
    async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
      try { await run(invocation, context); }
      catch {
        if (context.signal.aborted) return;
        context.log.error("aitc_failed");
        await edit(context, invocation, "AITC 调用失败，请检查配置和网络", false);
      }
    };
  const setString = (field: "prompt", missing: string, success: string) => async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const rest = invocation.args.join(" ").trim();
    if (!rest) { await edit(context, invocation, missing, false); return; }
    await store(context).update(current => validateConfig(current, {[field]: rest}));
    await edit(context, invocation, success, false);
  };
  const setTemperature = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const rest = invocation.args.join(" ").trim();
    const value = Number(rest);
    if (!rest || !Number.isFinite(value) || value < 0 || value > 2) { await edit(context, invocation, "温度必须是 0 到 2 之间的数字", false); return; }
    await store(context).update(current => validateConfig(current, {temperature: value}));
    await edit(context, invocation, "温度已更新", false);
  };
  const setPreset = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    const name = invocation.args[0]?.toLowerCase() ?? "";
    const value = invocation.args.slice(1).join(" ").trim();
    if (!/^[a-z0-9_-]{1,32}$/.test(name) || RESERVED.has(name) || !value) { await edit(context, invocation, "Prompt 预设需要有效名称和内容", false); return; }
    await store(context).update(current => validateConfig(current, {prompts: {...current.prompts, [name]: value}}));
    await edit(context, invocation, `Prompt「${escape(name)}」已保存`);
  };
  const info = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    await migrateAi(context);
    const config = await store(context).read();
    const names = Object.keys(config.prompts).sort();
    let selection = "请先安装并配置 ai 插件";
    if (context.services.available("ai", "selection")) {
      const selected = await context.services.call<{chat?: {tag?: string; model?: string}}>("ai", "selection", null, context.signal);
      selection = selected.chat?.tag && selected.chat.model ? `${selected.chat.tag} / ${selected.chat.model}` : "请在 ai 插件中设置聊天模型";
    }
    await edit(context, invocation, `<b>AITC 配置</b>\nAI：<code>${escape(selection)}</code>\n温度：<code>${config.temperature}</code>\n默认 Prompt：${escape(config.prompt)}\n预设：${names.length ? names.map(name => `<code>${escape(name)}</code>`).join(" · ") : "未保存"}`);
  };
  const centralConfig = async (invocation: CommandInvocation, context: PluginContext): Promise<void> =>
    edit(context, invocation, `供应商与模型由 ai 插件统一管理，请使用 ${invocation.prefix}ai config 和 ${invocation.prefix}ai model chat。`, false);
  const aitc: CommandDefinition = {
    description: "AI 转写与 Prompt 预设管理",
    helpArgs: ["help", "h"],
    args: "[预设] [文本]",
    arguments: [{name: "预设", description: "已保存的 Prompt 预设名；省略时使用默认 Prompt"}, {name: "文本", description: "要转写的文本；也可回复一条文字消息"}],
    examples: [{args: "文本"}, {args: "预设 文本"}, {args: "info"}],
    help: [
      {heading: "说明：", body: "使用 ai 插件当前聊天供应商与模型，温度默认 0.2，默认 Prompt 转写为英文。检索 Prompt 预设名后跟文本即使用该预设，否则使用默认 Prompt。"},
      {heading: "AI 配置：", body: "先安装 ai 插件，再用 <code>{prefix}ai config</code> 与 <code>{prefix}ai model chat</code> 统一管理供应商、密钥和模型。"},
    ],
    subcommandsCaseSensitive: false,
    subcommands: {
      key: {aliases: ["apikey", "_set_key"], description: "查看统一 AI 配置方式", args: "", handle: guard(centralConfig)},
      url: {aliases: ["api", "_set_url", "_set_api"], description: "查看统一 AI 配置方式", args: "", handle: guard(centralConfig)},
      model: {aliases: ["_set_model"], description: "查看统一 AI 配置方式", args: "", handle: guard(centralConfig)},
      prompt: {aliases: ["_set_prompt"], description: "设置默认 Prompt", args: "Prompt 文本", examples: [{args: "prompt 翻译为英文"}], handle: guard(setString("prompt", "请提供 Prompt 文本", "默认 Prompt 已更新"))},
      temp: {aliases: ["temperature", "_set_temperature"], description: "设置模型温度", args: "0-2", examples: [{args: "temp 0.2"}], handle: guard(setTemperature)},
      spn: {description: "保存或更新 Prompt 预设", args: "名称 Prompt", arguments: [{name: "名称", required: true, description: "字母、数字、下划线或连字符，1-32 位"}, {name: "Prompt", required: true, description: "预设内容"}], examples: [{args: "spn en Translate to English"}], handle: guard(setPreset)},
      info: {aliases: ["_info"], description: "查看当前配置", args: "", examples: [{args: "info"}], handle: guard(info)},
    },
    async handle(invocation, context) {
      const first = invocation.args[0]?.toLowerCase() ?? "";
      const rest = invocation.args.slice(1).join(" ").trim();
      if (first === "help" || first === "h" || (!first && invocation.message.replyToId === undefined)) {
        await edit(context, invocation, renderCommandHelp("aitc", aitc, {prefix: invocation.prefix}), true); return;
      }
      try {
        if (first.startsWith("_")) { await edit(context, invocation, "未知配置命令", false); return; }
        const config = await store(context).read();
        let prompt = config.prompt;
        let input = invocation.args.join(" ").trim();
        if (config.prompts[first]) { prompt = config.prompts[first]!; input = rest; }
        if (!input && invocation.message.replyToId !== undefined) input = (await context.telegram.getReply(invocation.message))?.text.trim() ?? "";
        if (!input) { await edit(context, invocation, "请提供文本或回复一条文字消息", false); return; }
        if (input.length > 50_000) { await edit(context, invocation, "输入文本过长", false); return; }
        await migrateAi(context);
        if (!context.services.available("ai", "chat")) { await edit(context, invocation, "请先安装并配置 ai 插件", false); return; }
        await edit(context, invocation, "正在请求…", false);
        const content = await context.services.call<string>("ai", "chat", {text: input, systemPrompt: prompt, temperature: config.temperature}, context.signal);
        if (typeof content !== "string" || !content.trim()) throw new Error("Empty output");
        await edit(context, invocation, content.trim(), false);
      } catch {
        if (context.signal.aborted) return;
        context.log.error("aitc_failed");
        await edit(context, invocation, "AITC 调用失败，请检查配置和网络", false);
      }
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "aitc", description: "使用统一 AI 服务和自定义 Prompt 转写文本",
    renderHelp: prefix => renderCommandHelp("aitc", aitc, {prefix, title: "自定义 Prompt 的 AI 转写插件："}),
    commands: {aitc},
    settings: context => ({
      id: "aitc", title: "AITC", description: "Prompt 与转写参数", category: "插件配置", icon: "✨",
      getSchema: () => [
        {key: "temperature", label: "温度", type: "number", min: 0, max: 2},
        {key: "prompt", label: "默认 Prompt", type: "textarea", required: true},
        {key: "prompts", label: "Prompt 预设", type: "prompt-map"},
      ],
      async getValues() { const value = await store(context).read(); return {temperature:value.temperature, prompt:value.prompt, prompts:value.prompts}; },
      setValues: async patch => { await store(context).update(current => validateConfig(current, patch)); },
    }),
    setup: migrateAi,
  });
}
