import type { PluginContext, MessageEnvelope } from "telebox/sdk";
import {buildChatRequest, parseChatText, readBody, resolveProviderType, ProviderError} from "./provider";
import {type Config, record, requireInput, updateConfig} from "./config";

export interface Source {url: string; title?: string}
export const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export async function request(ctx: PluginContext, url: string, init: RequestInit, signal: AbortSignal, timeout: number): Promise<string> {
  const result = await ctx.http.withResponse(url, init, async (response, active) => {
    try {
      if (!response.ok) return {error: new ProviderError("HTTP_STATUS", response.status)};
      return {text: await readBody(response, active, 2 * 1024 * 1024)};
    } catch (error) { return {error: error instanceof ProviderError ? error : new ProviderError("FAILED")}; }
  }, {signal, timeoutMs: timeout * 1000});
  signal.throwIfAborted();
  if (result.error) throw result.error;
  return result.text!;
}

export async function searchText(cfg: Config, ctx: PluginContext, text: string, signal: AbortSignal): Promise<{text: string; sources: Source[]}> {
  let selected = {...cfg, currentChatTag: cfg.currentSearchTag, currentChatModel: cfg.currentSearchModel,
    currentChatReasoningEffort: cfg.currentSearchReasoningEffort, currentChatServiceTier: cfg.currentSearchServiceTier};
  const provider = selected.configs[selected.currentChatTag];
  if (!provider) throw new ProviderError("CONFIG");
  const type = resolveProviderType(provider);
  requireInput(type !== "doubao" && type !== "moonshot", `当前 ${type} 提供商不支持 search 模式`);
  if (type === "local-cliproxy" && selected.currentChatModel.includes("gemini")) {
    const url = new URL(provider.url);
    if (!url.pathname.startsWith("/v1beta")) url.pathname = "/v1beta";
    url.search = ""; url.hash = "";
    selected = {...selected, configs: {...selected.configs, [selected.currentChatTag]: {...provider, type: "gemini", url: url.toString()}}};
  }
  const req = buildChatRequest(selected, text);
  const body = JSON.parse(String(req.init.body));
  if (req.format === "gemini") body.tools = [{googleSearch: {}}];
  else if (provider.responses) { body.tools = [{type: "web_search"}]; body.include = ["web_search_call.action.sources"]; }
  else { body.tools = [{type: "web_search", web_search: {searchContextSize: "high"}}]; body.web_search_options = {search_context_size: "high"}; }
  const raw = await request(ctx, req.url, {...req.init, body: JSON.stringify(body)}, signal, cfg.timeout);
  const output = parseChatText(raw, req.format);
  const sources: Source[] = [];
  const seen = new Set<string>();
  const append = (url: unknown, title: unknown): void => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url); sources.push({url, ...(typeof title === "string" ? {title} : {})});
  };
  const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith("data:"));
  const parsed = lines.length ? lines.map(line => line.slice(5).trim()).filter(line => line && line !== "[DONE]").map(line => JSON.parse(line)) : JSON.parse(raw);
  for (const payload of (Array.isArray(parsed) ? parsed : [parsed]).map(record)) {
    if (req.format === "gemini") {
      const root = record(payload.response ?? payload.data ?? payload);
      const candidate = record(list(root.candidates)[0]);
      const metadata = record(candidate.groundingMetadata ?? candidate.grounding_metadata);
      for (const chunk of list(metadata.groundingChunks ?? metadata.grounding_chunks).map(record)) {
        const web = record(chunk.web ?? chunk.web_chunk); append(web.uri, web.title);
      }
    } else {
      const choice = record(list(payload.choices)[0]);
      for (const obj of [payload, choice, record(choice.message), record(choice.delta)]) {
        for (const entry of [...list(obj.citations), ...list(obj.annotations)].map(record)) {
          const citation = record(entry.url_citation ?? entry); append(citation.url, citation.title);
        }
      }
      const response = record(payload.response ?? payload);
      for (const item of [payload.item, ...list(response.output)].map(record)) {
        for (const part of list(item.content).map(record)) for (const annotation of list(part.annotations).map(record)) append(annotation.url, annotation.title);
        for (const action of (Array.isArray(item.action) ? item.action : [item.action]).map(record)) for (const source of list(action.sources).map(record)) append(source.url, source.title);
      }
      for (const annotation of list(record(payload.part).annotations).map(record)) append(annotation.url, annotation.title);
    }
  }
  return {text: output, sources};
}

export function chunks(text: string, limit = 3000): string[] {
  const result: string[] = []; let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > limit) {result.push(chunk); chunk = "";}
    chunk += character;
  }
  if (chunk) result.push(chunk);
  return result;
}

export async function sendText(ctx: PluginContext, message: MessageEnvelope, text: string, signal: AbortSignal, collapse = false): Promise<void> {
  // Bound escaped HTML, not just source text, and never split an entity or surrogate pair.
  let page = "";
  const pages: string[] = [];
  for (const character of text) {
    const escaped = escape(character);
    if (page.length + escaped.length > 3600) {pages.push(page); page = "";}
    page += escaped;
  }
  if (page) pages.push(page);
  for (let i = 0; i < pages.length; i++) {
    signal.throwIfAborted();
    const html = collapse ? `<blockquote expandable>${pages[i]}</blockquote>` : pages[i];
    if (!i) await ctx.telegram.edit(message, html, {parseMode: "html", linkPreview: false});
    else await ctx.telegram.reply(message, html, {parseMode: "html", linkPreview: false});
    signal.throwIfAborted();
  }
}

export async function publish(ctx: PluginContext, cfg: Config, question: string, answer: string, signal: AbortSignal): Promise<string> {
  const post = async (method: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = JSON.parse(await request(ctx, `https://api.telegra.ph/${method}`, {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
    }, signal, cfg.timeout));
    if (response.ok !== true) throw new ProviderError("PROVIDER");
    return record(response.result);
  };
  let token = cfg.telegraphToken;
  if (!token) {
    const account = await post("createAccount", {short_name: "TeleBoxAI", author_name: "TeleBox"});
    if (typeof account.access_token !== "string" || !account.access_token) throw new ProviderError("INVALID_RESPONSE");
    token = account.access_token;
    await updateConfig(ctx, raw => { raw.telegraphToken = token; }, signal);
  }
  const compact = question.replace(/\s+/g, " ").trim();
  const title = compact.length > 24 ? compact.slice(0, 24) + "…" : compact || `Telegraph - ${new Date().toISOString()}`;
  const content = [{tag: "h3", children: ["Q"]}, {tag: "p", children: [question]}, {tag: "h3", children: ["A"]},
    ...answer.split("\n").map(line => ({tag: "p", children: [line]}))];
  const page = await post("createPage", {access_token: token, title, content, return_content: false});
  if (typeof page.url !== "string" || !/^https:\/\/telegra\.ph\//.test(page.url)) throw new ProviderError("INVALID_RESPONSE");
  const item = {url: page.url, title, createdAt: new Date().toISOString()};
  await updateConfig(ctx, (raw, view) => {
    raw.telegraph = {...record(raw.telegraph), list: [...view.telegraph.list, item].slice(-view.telegraph.limit)};
  }, signal);
  return page.url;
}
