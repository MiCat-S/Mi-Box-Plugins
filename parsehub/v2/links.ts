const TRAILING_PUNCTUATION = /[)\]}。：！？、，>.,;!?]+$/u;
const PROGRESS_DECORATION = /^[\s\u2580-\u259f\u25a0-\u25ff\u2000-\u200f\ufeff\u3000]+/u;
const PROGRESS_PREFIXES = ["解 析 中", "已有相同任务正在解析", "下 载 中", "上 传 中"] as const;

export function extractLinks(text: string, maximum = 10): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(/(?:https?:\/\/|www\.)\S+/gi) ?? []) {
    const candidate = raw.replace(TRAILING_PUNCTUATION, "");
    let url: URL;
    try {url = new URL(/^www\./i.test(candidate) ? `https://${candidate}` : candidate);}
    catch {continue;}
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > 2048) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    output.push(url.href);
    if (output.length === maximum) break;
  }
  return output;
}

export function isProgressText(text: unknown): boolean {
  if (typeof text !== "string" || !text) return false;
  const stripped = text.replace(PROGRESS_DECORATION, "").trim();
  return PROGRESS_PREFIXES.some(prefix => stripped.startsWith(prefix));
}

export function hasMediaPayload(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const media = (message as {media?: {className?: string}}).media;
  return Boolean(media && media.className !== "MessageMediaEmpty");
}

export function isFinalBotMessage(message: unknown): boolean {
  if (hasMediaPayload(message)) return true;
  const text = String((message as {message?: unknown} | undefined)?.message ?? "").trim();
  return Boolean(text) && !isProgressText(text);
}
