import {isIP} from "node:net";
import type {PluginContext} from "telebox/sdk";

async function readLocation(ctx: PluginContext, url: string): Promise<Record<string, unknown>> {
  return ctx.http.withResponse(url, {headers: {"User-Agent": "Mi-Box-DNS/2"}}, async (response, signal) => {
    if (!response.ok || !response.body) throw new Error("Location unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0, text = "", done = false;
    let cancellation: Promise<void> | undefined;
    const cancel = () => cancellation ??= reader.cancel();
    const onAbort = () => {void cancel().catch(() => undefined);};
    signal.addEventListener("abort", onAbort, {once: true});
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) {done = true; break;}
        bytes += chunk.value.byteLength;
        if (bytes > 16_384) throw new Error("Location response too large");
        text += decoder.decode(chunk.value, {stream: true});
      }
      text += decoder.decode();
      const data: unknown = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid location");
      return data as Record<string, unknown>;
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {if (!done) await cancel();} finally {reader.releaseLock();}
    }
  }, {timeoutMs: 3_000});
}

function label(data: Record<string, unknown>): string {
  if (data.bogon === true) return "";
  const text = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 200) : "";
  const place = [...new Set([data.country, data.region, data.city].map(text).filter(Boolean))].join(" · ");
  const asn = typeof data.asn === "number" && Number.isSafeInteger(data.asn) && data.asn > 0
    ? `AS${data.asn}` : /^(?:AS)?\d+$/.test(text(data.asn))
      ? `AS${text(data.asn).replace(/^AS/, "")}` : text(data.org).match(/\bAS\d+\b/)?.[0] ?? "";
  return [place, asn].filter(Boolean).join(" · ");
}

export async function annotateLocations(ctx: PluginContext, output: string): Promise<string> {
  // Per-command deduplication avoids persistent caches and repeated lookups for one IP.
  const locations = new Map<string, string>();
  const lines: string[] = [];
  for (const line of output.split("\n")) {
    ctx.signal.throwIfAborted();
    const value = line.trim();
    const address = isIP(value) ? value : value.match(/^\S+\s+\d+\s+IN\s+(?:A|AAAA)\s+(\S+)\s*$/)?.[1];
    if (address && isIP(address) && !locations.has(address)) {
      let location = "";
      for (const url of [`https://api.ip.sb/geoip/${encodeURIComponent(address)}`, `https://ipinfo.io/${encodeURIComponent(address)}/json`]) {
        ctx.signal.throwIfAborted();
        try {location = label(await readLocation(ctx, url));} catch {ctx.signal.throwIfAborted();}
        if (location) break;
      }
      locations.set(address, location);
    }
    lines.push(line);
    const location = address && locations.get(address);
    if (location) lines.push(`  ${location}`);
  }
  return lines.join("\n");
}
