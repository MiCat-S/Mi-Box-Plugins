import type { PluginContext, PluginDefinition } from "telebox/sdk";
import {
  assertAllowedModel, normalizeOpenAIBaseUrl, resolveProviderType,
  type ChatConfigSnapshot, type ProviderConfig, type ReasoningEffort, type ServiceTier,
} from "./provider";

export const reasoningValues = ["auto", "none", "minimal", "low", "medium", "high", "xhigh"] as const;
export const tierValues = ["auto", "default", "priority", "fast", "flex"] as const;
export const providerTypes = ["openai-compatible", "openai", "gemini", "anthropic", "codex", "doubao", "moonshot", "local-cliproxy"] as const;
export const modes = ["Chat", "Search", "Image", "Video"] as const;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export interface Config extends Mutable<ChatConfigSnapshot>, Record<string, unknown> {
  configs: Record<string, Mutable<ProviderConfig> & Record<string, unknown>>;
  currentSearchTag: string; currentSearchModel: string;
  currentSearchReasoningEffort: ReasoningEffort; currentSearchServiceTier: ServiceTier;
  currentImageTag: string; currentImageModel: string;
  currentVideoTag: string; currentVideoModel: string;
  imagePreview: boolean; videoPreview: boolean; videoAudio: boolean; videoDuration: number;
  collapse: boolean; telegraphToken: string;
  telegraph: {enabled: boolean; limit: number; list: {url: string; title: string; createdAt: string}[]; [key: string]: unknown};
}
export class InputError extends Error {}
export function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InputError(message);
}
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function providerUrl(provider: Record<string, unknown>): string {
  const url = typeof provider.url === "string" ? provider.url : "";
  if (!URL.canParse(url)) return url;
  const pathname = new URL(url).pathname;
  const type = resolveProviderType({url, ...(typeof provider.type === "string" ? {type: provider.type as ProviderConfig["type"]} : {})});
  if ((pathname === "" || pathname === "/") && ["openai", "openai-compatible", "moonshot"].includes(type)) {
    return normalizeOpenAIBaseUrl(url);
  }
  return url;
}
export function defaults(): Config {
  return {
    configs: {}, currentChatTag: "", currentChatModel: "", currentChatReasoningEffort: "auto", currentChatServiceTier: "auto",
    currentSearchTag: "", currentSearchModel: "", currentSearchReasoningEffort: "auto", currentSearchServiceTier: "auto",
    currentImageTag: "", currentImageModel: "", currentVideoTag: "", currentVideoModel: "",
    imagePreview: true, videoPreview: true, videoAudio: false, videoDuration: 5,
    prompt: "", collapse: true, timeout: 30, telegraphToken: "", telegraph: {enabled: false, limit: 5, list: []},
  };
}

/** Defaults are a read-time view. Unknown and invalid legacy fields remain intact on disk. */
export function snapshot(raw: Record<string, unknown>): Config {
  const base = defaults();
  const cfg = {...base, ...raw, configs: {...record(raw.configs)}, telegraph: {...base.telegraph, ...record(raw.telegraph)}} as Config;
  for (const [tag, value] of Object.entries(cfg.configs)) {
    const p = record(value);
    const modelSource = record(p.models);
    const models = Object.fromEntries(["chat", "search", "image", "video"].flatMap(mode =>
      typeof modelSource[mode] === "string" && String(modelSource[mode]).trim() ? [[mode, String(modelSource[mode]).trim()]] : []));
    cfg.configs[tag] = {...p, tag, url: providerUrl(p), key: typeof p.key === "string" ? p.key : "",
      stream: p.stream === true, responses: p.responses === true, models} as Config["configs"][string];
  }
  for (const mode of modes) for (const suffix of ["Tag", "Model"] as const) {
    const key = `current${mode}${suffix}` as const;
    if (typeof cfg[key] !== "string") cfg[key] = "";
    // Missing legacy selections inherit chat; an explicitly cleared selection stays cleared.
    if (!Object.hasOwn(raw, key) && mode !== "Chat") cfg[key] = cfg[`currentChat${suffix}`];
  }
  for (const mode of ["Chat", "Search"] as const) {
    const effort = String(cfg[`current${mode}ReasoningEffort`] ?? "").trim().toLowerCase();
    const tier = String(cfg[`current${mode}ServiceTier`] ?? "").trim().toLowerCase();
    cfg[`current${mode}ReasoningEffort`] = reasoningValues.includes(effort as ReasoningEffort) ? effort as ReasoningEffort : "auto";
    cfg[`current${mode}ServiceTier`] = tierValues.includes(tier as ServiceTier) ? tier as ServiceTier : "auto";
  }
  for (const key of ["imagePreview", "videoPreview", "videoAudio", "collapse"] as const) if (typeof cfg[key] !== "boolean") cfg[key] = base[key];
  for (const key of ["prompt", "telegraphToken"] as const) if (typeof cfg[key] !== "string") cfg[key] = "";
  if (!Number.isFinite(cfg.timeout) || cfg.timeout <= 0 || cfg.timeout > 2147483) cfg.timeout = 30;
  if (!Number.isInteger(cfg.videoDuration) || cfg.videoDuration < 5 || cfg.videoDuration > 20) cfg.videoDuration = 5;
  if (typeof cfg.telegraph.enabled !== "boolean") cfg.telegraph.enabled = false;
  if (!Number.isSafeInteger(cfg.telegraph.limit) || cfg.telegraph.limit <= 0) cfg.telegraph.limit = 5;
  cfg.telegraph.list = Array.isArray(cfg.telegraph.list) ? cfg.telegraph.list.filter(item =>
    item && typeof item.url === "string" && typeof item.title === "string" && typeof item.createdAt === "string") : [];
  return cfg;
}
const store = (ctx: PluginContext) => ctx.storage.json<Record<string, unknown>>("config.json", defaults());
export async function readConfig(ctx: PluginContext, signal = ctx.signal): Promise<Config> {
  signal.throwIfAborted();
  const result = snapshot(await store(ctx).read(signal));
  signal.throwIfAborted();
  return result;
}
export async function updateConfig(ctx: PluginContext, mutate: (raw: Record<string, unknown>, view: Config) => void, signal = ctx.signal): Promise<void> {
  await store(ctx).update(raw => { signal.throwIfAborted(); mutate(raw, snapshot(raw)); return raw; }, signal);
}

type Schema = Awaited<ReturnType<ReturnType<NonNullable<PluginDefinition["settings"]>>["getSchema"]>>;
const schema: Schema = [
  {key: "configs", label: "API 配置 JSON", type: "json", secret: true},
  ...modes.flatMap(mode => ([
    {key: `current${mode}Tag`, label: `${mode} Tag`, type: "string" as const},
    {key: `current${mode}Model`, label: `${mode} 模型`, type: "string" as const},
  ])),
  ...(["Chat", "Search"] as const).flatMap(mode => ([
    {key: `current${mode}ReasoningEffort`, label: `${mode} 思考强度`, type: "select" as const, options: reasoningValues.map(value => ({value, label: value}))},
    {key: `current${mode}ServiceTier`, label: `${mode} 服务等级`, type: "select" as const, options: tierValues.map(value => ({value, label: value}))},
  ])),
  ...(["imagePreview", "videoPreview", "videoAudio", "collapse"] as const).map(key => ({key, label: key, type: "boolean" as const})),
  {key: "videoDuration", label: "视频时长（秒）", type: "number", min: 5, max: 20, default: 5},
  {key: "prompt", label: "系统提示词", type: "textarea"},
  {key: "timeout", label: "请求超时（秒）", type: "number", min: 1, max: 600, default: 30},
  {key: "telegraphToken", label: "Telegraph Token", type: "password", secret: true},
  {key: "telegraph.enabled", label: "Telegraph 发布", type: "boolean"},
  {key: "telegraph.limit", label: "Telegraph 记录容量", type: "number", min: 1, default: 5},
];
export const settings: NonNullable<PluginDefinition["settings"]> = ctx => ({
  id: "ai", title: "AI 对话", description: "提供商、模型、媒体与输出配置", category: "插件配置",
  getSchema: () => schema,
  async getValues(signal) {
    const cfg = await readConfig(ctx, signal);
    return {...cfg, "telegraph.enabled": cfg.telegraph.enabled, "telegraph.limit": cfg.telegraph.limit};
  },
  async setValues(patch, signal) {
    // Check here as well so direct adapter callers cannot bypass validation.
    for (const [key, value] of Object.entries(patch)) {
      const field = schema.find(field => field.key === key);
      requireInput(field, "未知配置字段");
      if (field.type === "number") requireInput(Number.isSafeInteger(value) && Number(value) >= (field.min ?? 0) && Number(value) <= (field.max ?? Number.MAX_SAFE_INTEGER), "数值超出范围");
      else if (field.type === "boolean") requireInput(typeof value === "boolean", "需要布尔值");
      else if (field.type !== "json") requireInput(typeof value === "string", "需要文本值");
      if (field.options) requireInput(field.options.some(option => option.value === value), "无效选项");
      if (/^current(?:Chat|Search|Image|Video)Model$/.test(key) && typeof value === "string") assertAllowedModel(value);
    }
    await updateConfig(ctx, raw => {
      for (const [key, value] of Object.entries(patch)) {
        if (key.startsWith("telegraph.")) raw.telegraph = {...record(raw.telegraph), [key.slice(10)]: value};
        else if (key === "configs") {
          let parsed = value;
          if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { throw new InputError("API 配置 JSON 无效"); } }
          requireInput(parsed && typeof parsed === "object" && !Array.isArray(parsed), "API 配置必须是对象");
          const merged = {...record(raw.configs)};
          for (const [tag, provider] of Object.entries(record(parsed))) {
            requireInput(!["__proto__", "constructor", "prototype"].includes(tag) && Object.keys(record(provider)).length, "无效 API 配置");
            merged[tag] = {...record(merged[tag]), ...record(provider)};
          }
          raw.configs = merged;
        } else raw[key] = value;
      }
    }, signal);
  },
});
