import type {PluginContext} from "telebox/sdk";
import type {CustomProvider, ProviderProtocol, ReasoningEffort, ServiceTier} from "./model";

const CODEX_USER_AGENT = "codex-tui/0.146.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.146.0)";

export const normalizedBaseUrl = (url: string): string => url.replace(/\/+$/, "").replace(/\/v1(?:beta)?$/i, "");
export function detectProtocol(provider: CustomProvider): Exclude<ProviderProtocol, "auto"> {
  if (provider.type && provider.type !== "auto" && provider.type !== "openai") return provider.type;
  const model = provider.model.toLowerCase();
  if (model.startsWith("gemini")) return "gemini";
  if (model.startsWith("claude")) return "anthropic";
  return /^(gpt-[5-9]|o[1-9])/.test(model) ? "responses" : "chat";
}

function parseText(raw: string, gemini: boolean): string {
  const payloads = raw.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim()).filter(line => line && line !== "[DONE]").map(line => JSON.parse(line)) as any[];
  const values = payloads.length ? payloads : [JSON.parse(raw)];
  const text = gemini
    ? values.flatMap(value => (value.response ?? value.data ?? value).candidates?.[0]?.content?.parts ?? []).map(part => part?.text ?? "").join("")
    : values.map(value => value.choices?.[0]?.delta?.content ?? value.choices?.[0]?.message?.content ?? value.choices?.[0]?.text ?? value.text ?? "").join("");
  if (!text.trim()) throw new Error("AI 返回内容为空");
  return text.trim();
}

async function consume(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  const buffer = new Uint8Array(2 * 1024 * 1024);
  let length = 0, done = !reader;
  let cancellation: Promise<void> | undefined;
  const cancel = () => cancellation ??= reader!.cancel();
  const onAbort = () => { void cancel().catch(() => undefined); };
  if (reader) signal.addEventListener("abort", onAbort, {once: true});
  try {
    while (reader) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) { done = true; break; }
      if (chunk.value.length > buffer.length - length) throw new Error("AI response exceeds byte limit");
      buffer.set(chunk.value, length); length += chunk.value.length;
    }
    return {status: response.status, ok: response.ok, text: new TextDecoder().decode(buffer.subarray(0, length))};
  } finally {
    if (reader) {
      signal.removeEventListener("abort", onAbort);
      try { if (!done || cancellation) await cancel(); } finally { reader.releaseLock(); }
    }
  }
}

export async function callAI(ctx: PluginContext, provider: CustomProvider, messages: string, prompt: string,
  reasoning: ReasoningEffort, tier: ServiceTier, timeout: number, signal: AbortSignal): Promise<string> {
  if (/^gpt-5\.6-(luna|terra)(?:$|[-/])/i.test(provider.model.trim())) throw new Error("配置模型被项目策略禁止，请更换模型");
  const input = `${prompt}\n\n${messages}`;
  const base = normalizedBaseUrl(provider.base_url);
  const request = async (protocol: Exclude<ProviderProtocol, "auto">) => {
    signal.throwIfAborted();
    const headers: Record<string, string> = {"Content-Type": "application/json"};
    let url: string, data: Record<string, unknown>;
    if (protocol === "gemini") {
      url = `${base}/v1beta/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.api_key)}`;
      data = {contents: [{role: "user", parts: [{text: input}]}]};
    } else if (protocol === "anthropic") {
      url = `${base}/v1/messages`;
      headers["x-api-key"] = provider.api_key; headers["anthropic-version"] = "2023-06-01";
      data = {model: provider.model, max_tokens: 2000, messages: [{role: "user", content: input}]};
    } else {
      headers.Authorization = `Bearer ${provider.api_key}`; headers["User-Agent"] = CODEX_USER_AGENT;
      url = `${base}/v1/${protocol === "responses" ? "responses" : "chat/completions"}`;
      data = protocol === "responses"
        ? {model: provider.model, input: [{role: "user", content: [{type: "input_text", text: input}]}], max_output_tokens: 2000, store: false}
        : {model: provider.model, messages: [{role: "user", content: input}], max_tokens: 2000};
      if (reasoning !== "auto") data[protocol === "responses" ? "reasoning" : "reasoning_effort"] = protocol === "responses" ? {effort: reasoning} : reasoning;
      if (tier !== "auto") data.service_tier = tier;
    }
    return ctx.http.withResponse(url, {method: "POST", headers, body: JSON.stringify(data), redirect: "manual", credentials: "omit"}, consume, {signal, timeoutMs: timeout});
  };
  let protocol = detectProtocol(provider);
  let result = await request(protocol);
  if (!result.ok && (!provider.type || provider.type === "auto" || provider.type === "openai") && protocol !== "chat" &&
      (result.status === 404 || result.status === 400 && /unsupported_upstream|endpoint|not supported/i.test(result.text))) {
    protocol = "chat"; result = await request(protocol);
  }
  signal.throwIfAborted();
  if (!result.ok) throw new Error(`AI HTTP ${result.status}`);
  if (protocol === "anthropic" || protocol === "responses") {
    let data: any;
    try { data = JSON.parse(result.text); } catch { throw new Error("AI 返回无效 JSON"); }
    if (data.error || data.status === "failed") throw new Error("AI 提供商返回错误");
    const content = protocol === "anthropic"
      ? data.content?.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n")
      : data.output_text || data.output?.flatMap((item: any) => item?.content ?? []).filter((item: any) => item?.type === "output_text").map((item: any) => item.text).join("\n");
    if (typeof content !== "string" || !content.trim()) throw new Error("AI 返回内容为空");
    return content.trim();
  }
  try { return parseText(result.text, protocol === "gemini"); }
  catch (error) { if (error instanceof Error && error.message === "AI 返回内容为空") throw error; throw new Error("AI 返回无效 JSON"); }
}
