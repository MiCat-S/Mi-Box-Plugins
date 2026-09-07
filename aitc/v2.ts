import {definePlugin, type PluginContext} from "telebox/sdk";

type Config = {
  apiKey: string;
  apiUrl: string;
  model: string;
  prompt: string;
  prompts: Record<string, string>;
  temperature: number;
};

const defaults: Config = {
  apiKey: "",
  apiUrl: "https://api.openai.com",
  model: "gpt-4o-mini",
  prompt: "Translate the user's Chinese text into natural colloquial English. Preserve meaning and tone. Output only the translation.",
  prompts: {},
  temperature: 0.2,
};
const RESERVED = new Set(["apikey", "key", "api", "url", "model", "prompt", "temp", "temperature", "info", "spn"]);
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function store(context: PluginContext) {
  return context.storage.json<Config>("config.json", defaults);
}

function endpoint(base: string): URL {
  const value = new URL(base);
  if (!/^https?:$/.test(value.protocol) || value.username || value.password) throw new Error("Invalid API URL");
  value.pathname = `${value.pathname.replace(/\/+$/, "")}/v1/chat/completions`;
  value.search = "";
  value.hash = "";
  return value;
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 1024 * 1024) throw new Error("Response too large");
      parts.push(part.value);
    }
    const text = Buffer.concat(parts, total).toString("utf8");
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error("Invalid response"); }
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    return data;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
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

const help = (prefix: string) => `<b>AITC AI 转写</b>\n` +
  `<code>${escape(prefix)}aitc 文本</code> 使用默认 Prompt\n` +
  `<code>${escape(prefix)}aitc 预设 文本</code> 使用 Prompt 预设\n` +
  `<code>${escape(prefix)}aitc key API_KEY</code> 设置密钥（仅收藏夹）\n` +
  `<code>${escape(prefix)}aitc url 地址</code> · <code>model 模型</code> · <code>temp 0-2</code>\n` +
  `<code>${escape(prefix)}aitc prompt 文本</code> · <code>spn 名称 Prompt</code> · <code>info</code>`;

export default function createAitc() {
  return definePlugin({apiVersion: 1, id: "aitc", description: "使用自定义 Prompt 和 OpenAI 兼容接口转写文本",
    commands: {aitc: {description: "AI 转写与 Prompt 预设管理", async handle(invocation, context) {
      const first = invocation.args[0]?.toLowerCase() ?? "";
      const rest = invocation.args.slice(1).join(" ").trim();
      const edit = (text: string, html = true) => context.telegram.edit(invocation.message, text,
        html ? {parseMode: "html", linkPreview: false} : {linkPreview: false});
      if (first === "help" || first === "h" || (!first && invocation.message.replyToId === undefined)) {
        await edit(help(invocation.prefix)); return;
      }
      try {
        if (["key", "apikey", "_set_key"].includes(first)) {
          if (!invocation.message.saved) { await edit("涉及 API Key 的配置仅限在收藏夹中使用", false); return; }
          if (!rest) { await edit("请提供 API Key", false); return; }
          await store(context).update(current => validateConfig(current, {apiKey: rest}));
          await edit("API Key 已更新", false);
          return;
        }
        if (["url", "api", "_set_url", "_set_api"].includes(first)) {
          if (!rest) { await edit("请提供 API 地址", false); return; }
          await store(context).update(current => validateConfig(current, {apiUrl: rest}));
          await edit("API 地址已更新", false); return;
        }
        if (["model", "_set_model"].includes(first)) {
          if (!rest) { await edit("请提供模型名称", false); return; }
          await store(context).update(current => validateConfig(current, {model: rest}));
          await edit("模型已更新", false); return;
        }
        if (["prompt", "_set_prompt"].includes(first)) {
          if (!rest) { await edit("请提供 Prompt 文本", false); return; }
          await store(context).update(current => validateConfig(current, {prompt: rest}));
          await edit("默认 Prompt 已更新", false); return;
        }
        if (["temp", "temperature", "_set_temperature"].includes(first)) {
          const value = Number(rest);
          if (!rest || !Number.isFinite(value) || value < 0 || value > 2) { await edit("温度必须是 0 到 2 之间的数字", false); return; }
          await store(context).update(current => validateConfig(current, {temperature: value}));
          await edit("温度已更新", false); return;
        }
        if (first === "spn") {
          const name = invocation.args[1]?.toLowerCase() ?? "";
          const value = invocation.args.slice(2).join(" ").trim();
          if (!/^[a-z0-9_-]{1,32}$/.test(name) || RESERVED.has(name) || !value) { await edit("Prompt 预设需要有效名称和内容", false); return; }
          await store(context).update(current => validateConfig(current, {prompts: {...current.prompts, [name]: value}}));
          await edit(`Prompt「${escape(name)}」已保存`); return;
        }
        const config = await store(context).read();
        if (first === "info" || first === "_info") {
          const names = Object.keys(config.prompts).sort();
          await edit(`<b>AITC 配置</b>\nAPI：<code>${escape(config.apiUrl)}</code>\n模型：<code>${escape(config.model)}</code>\n温度：<code>${config.temperature}</code>\n默认 Prompt：${escape(config.prompt)}\n预设：${names.length ? names.map(name => `<code>${escape(name)}</code>`).join(" · ") : "未保存"}\nAPI Key：${config.apiKey ? "已配置" : "未配置"}`);
          return;
        }
        if (first.startsWith("_")) { await edit("未知配置命令", false); return; }
        let prompt = config.prompt;
        let input = invocation.args.join(" ").trim();
        if (config.prompts[first]) { prompt = config.prompts[first]!; input = rest; }
        if (!input && invocation.message.replyToId !== undefined) input = (await context.telegram.getReply(invocation.message))?.text.trim() ?? "";
        if (!input) { await edit("请提供文本或回复一条文字消息", false); return; }
        if (input.length > 50_000) { await edit("输入文本过长", false); return; }
        if (!config.apiKey) { await edit("未配置 API Key，请先在收藏夹中使用 aitc key 设置", false); return; }
        await edit("正在请求…", false);
        const target=endpoint(config.apiUrl);const data = await context.http.withResponse(target, {
          method: "POST", redirect: "manual", credentials: "omit",
          headers: {Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json"},
          body: JSON.stringify({model: config.model, messages: [{role: "system", content: prompt}, {role: "user", content: input}], temperature: config.temperature}),
        }, responseJson, {timeoutMs: 30_000, signal: context.signal, redirects:{allowedHosts:[new URL(target).hostname],maxRedirects:2}});
        const content = (data as any)?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) throw new Error("Empty output");
        await edit(content.trim(), false);
      } catch {
        if (context.signal.aborted) return;
        context.log.error("aitc_failed");
        await edit("AITC 调用失败，请检查配置和网络", false);
      }
    }}},
    settings: context => ({
      id: "aitc", title: "AITC", description: "OpenAI 兼容转写配置", category: "插件配置", icon: "✨",
      getSchema: () => [
        {key: "apiKey", label: "API Key", type: "password", secret: true},
        {key: "apiUrl", label: "API 地址", type: "string", required: true},
        {key: "model", label: "模型", type: "string", required: true},
        {key: "temperature", label: "温度", type: "number", min: 0, max: 2},
        {key: "prompt", label: "默认 Prompt", type: "textarea", required: true},
        {key: "prompts", label: "Prompt 预设", type: "prompt-map"},
      ],
      getValues: () => store(context).read(),
      setValues: async patch => { await store(context).update(current => validateConfig(current, patch)); },
    }),
  });
}
