import type {PluginContext} from "telebox/sdk";

/** Legacy `.diss 语录` behavior, preserved from the previous quote-only plugin. */
export async function fetchQuote(context: PluginContext, signal: AbortSignal): Promise<string> {
  let text: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    signal.throwIfAborted();
    try {
      text = await context.http.withResponse(
        "https://api.oddfar.com/yl/q.php?c=1009&encode=text",
        {headers: {"user-agent": "Mi Box"}},
        readQuote,
        {timeoutMs: 10_000, redirects: {allowedHosts: ["api.oddfar.com"], maxRedirects: 2}},
      );
      break;
    } catch {
      signal.throwIfAborted();
      if (attempt < 4) await delay(1_000, signal);
    }
  }
  signal.throwIfAborted();
  if (!text) throw new Error("语录服务不可用");
  return text;
}

async function readQuote(response: Response, signal: AbortSignal): Promise<string> {
  if (response.status !== 200 || !response.body) throw new Error("语录服务不可用");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  let cancellation: Promise<void> | undefined;
  const cancel = () => cancellation ??= reader.cancel();
  const abort = () => { void cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, {once: true});
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) {complete = true; break;}
      total += part.value.byteLength;
      if (total > 16 * 1024) throw new Error("语录响应过大");
      chunks.push(part.value);
    }
    const text = new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks, total)).trim();
    if (!text || text.length > 4000) throw new Error("语录内容无效");
    return text;
  } finally {
    signal.removeEventListener("abort", abort);
    try {if (!complete) await cancel();} finally {reader.releaseLock();}
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {signal.removeEventListener("abort", onAbort); resolve();}, ms);
    const onAbort = () => {clearTimeout(timer); reject(signal.reason);};
    signal.addEventListener("abort", onAbort, {once: true});
  });
}
