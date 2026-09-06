import type {PluginContext} from "telebox/sdk";

export async function fetchSubscription(ctx: PluginContext, url: string) {
  return ctx.http.withResponse(url, {headers: {"user-agent": "Mi Box"}}, async (response, signal) => {
    if (!response.ok || !response.body) throw new Error("Subscription unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "", total = 0, done = false;
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
        total += chunk.value.byteLength;
        if (total > 2 * 1024 * 1024) throw new Error("Subscription too large");
        text += decoder.decode(chunk.value, {stream: true});
      }
      text += decoder.decode();
      return {text, traffic: trafficSummary(response.headers.get("subscription-userinfo"))};
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {if (!done) await cancel();} finally {reader.releaseLock();}
    }
  }, {timeoutMs: 15_000});
}

function bytes(value: bigint): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let divisor = 1n, index = 0;
  while (value >= divisor * 1024n && index < units.length - 1) {divisor *= 1024n; index++;}
  return `${value / divisor}${index ? `.${((value % divisor) * 100n / divisor).toString().padStart(2, "0")}` : ""} ${units[index]}`;
}

export function trafficSummary(header: string | null, now = Date.now()): string {
  if (!header) return "流量统计: 未提供";
  const fields = new Map<string, bigint>();
  for (const part of header.split(";")) {
    const match = part.trim().match(/^(upload|download|total|expire|starttime)\s*=\s*(\d{1,20})$/i);
    if (match) fields.set(match[1].toLowerCase(), BigInt(match[2]));
  }
  const upload = fields.get("upload"), download = fields.get("download"), total = fields.get("total");
  const used = upload !== undefined && download !== undefined ? upload + download : undefined;
  const lines = [`上传: ${upload === undefined ? "未知" : bytes(upload)}`, `下载: ${download === undefined ? "未知" : bytes(download)}`];
  if (used !== undefined) lines.push(`已用: ${bytes(used)}`);
  lines.push(`总量: ${total === undefined ? "未知" : total === 0n ? "未设限" : bytes(total)}`);
  if (total !== undefined && total > 0n && used !== undefined) {
    lines.push(`剩余: ${bytes(total > used ? total - used : 0n)}`);
    if (used >= total) lines.push("流量状态: 已耗尽");
  }
  const expire = fields.get("expire");
  if (expire === undefined) lines.push("到期: 未提供");
  else if (expire === 0n) lines.push("到期: 未设期限");
  else if (expire <= 8_640_000_000_000n) {
    const time = Number(expire) * 1000;
    lines.push(`到期: ${new Date(time).toISOString().replace("T", " ").replace(".000Z", " UTC")}${time <= now ? "（已过期）" : ""}`);
  } else lines.push("到期: 无效时间");
  return lines.join("\n");
}
