import {isIP} from "node:net";
import {open, readFile, stat} from "node:fs/promises";
import path from "node:path";
import type {PluginContext, CommandInvocation} from "telebox/sdk";
import type {SpeedtestResult} from "./cli";
import {messageOrder, type MessageType} from "./config";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CAPTION_UTF16_LIMIT = 1024;
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;"})[character]!);
const clipped = (value: unknown, length = 80): string => String(value ?? "").slice(0, length);

export function visibleUtf16Length(html: string): number {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#x27);/g, "x")
    .length;
}

export function reportParts(report: string, result: SpeedtestResult): {body: string; caption: string; separateBody: boolean} {
  if (visibleUtf16Length(report) <= CAPTION_UTF16_LIMIT) return {body: report, caption: report, separateBody: false};
  const caption = [
    "<b>⚡ SPEEDTEST by OOKLA</b>",
    `<code>服务器</code> <code>${result.server.id} / ${escape(clipped(result.server.name, 80))}</code>`,
  ].join("\n");
  return {body: report, caption, separateBody: true};
}

function amount(value: number | undefined, bytes: boolean): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "失败";
  let current = bytes ? value : value * 8;
  const units = bytes ? ["B", "KB", "MB", "GB", "TB"] : ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let index = 0;
  while (current >= 1000 && index < units.length - 1) { current /= 1000; index += 1; }
  return `${Math.round(current * 100) / 100}${units[index]}`;
}

function number(value: number | null | undefined, suffix = ""): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "不可用" : `${Math.round(value * 100) / 100}${suffix}`;
}

type IpInfo = {as: string; country: string; code: string; flag: string};

async function ipInfo(context: PluginContext, ip: string): Promise<IpInfo> {
  if (!isIP(ip)) return {as: "", country: "", code: "", flag: ""};
  const url = new URL(`http://ip-api.com/json/${encodeURIComponent(ip)}`);
  url.searchParams.set("fields", "as,country,countryCode");
  try {
    const value = await context.http.json<Record<string, unknown>>(url, {method: "GET"}, {
      timeoutMs: 8_000, redirects: {allowedHosts: ["ip-api.com"], maxRedirects: 0},
    });
    const code = typeof value.countryCode === "string" && /^[A-Za-z]{2}$/.test(value.countryCode) ? value.countryCode.toUpperCase() : "";
    return {
      as: clipped(typeof value.as === "string" ? value.as.split(/\s+/)[0] : "", 32),
      country: clipped(typeof value.country === "string" ? value.country : "", 48),
      code,
      flag: code ? String.fromCodePoint(...[...code].map(character => 127397 + character.charCodeAt(0))) : "",
    };
  } catch {
    context.signal.throwIfAborted();
    return {as: "", country: "", code: "", flag: ""};
  }
}

type Traffic = {rx: number | null; tx: number | null; mtu: number | null};

async function interfaceTraffic(context: PluginContext, name: string): Promise<Traffic> {
  if (process.platform !== "linux" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) return {rx: null, tx: null, mtu: null};
  const root = path.join("/sys/class/net", name);
  try {
    const [rx, tx, mtu] = await context.tasks.run("speedtest:interface-traffic", async signal => {
      const values = await Promise.all([
        readFile(path.join(root, "statistics/rx_bytes"), {encoding: "utf8", signal}),
        readFile(path.join(root, "statistics/tx_bytes"), {encoding: "utf8", signal}),
        readFile(path.join(root, "mtu"), {encoding: "utf8", signal}),
      ]);
      return values.map(value => Number(value.trim()));
    });
    return {
      rx: Number.isSafeInteger(rx) && rx >= 0 ? rx : null,
      tx: Number.isSafeInteger(tx) && tx >= 0 ? tx : null,
      mtu: Number.isSafeInteger(mtu) && mtu > 0 ? mtu : null,
    };
  } catch {
    context.signal.throwIfAborted();
    return {rx: null, tx: null, mtu: null};
  }
}

export function officialResultUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "www.speedtest.net" || url.username || url.password || url.search || url.hash) return undefined;
    if (!/^\/result\/(?:c\/[A-Za-z0-9-]{1,128}|\d{1,20})$/.test(url.pathname)) return undefined;
    return url;
  } catch { return undefined; }
}

export async function buildReport(context: PluginContext, result: SpeedtestResult): Promise<string> {
  const [network, traffic] = await Promise.all([
    ipInfo(context, result.interface.externalIp),
    interfaceTraffic(context, result.interface.name),
  ]);
  const resultUrl = officialResultUrl(result.result?.url)?.toString();
  const titleSuffix = network.code ? ` @${network.code}${network.flag}` : "";
  const isp = [clipped(result.isp, 48), network.as].filter(Boolean).join(" ") || "不可用";
  const connection = [isIP(result.interface.externalIp) === 6 ? "IPv6" : isIP(result.interface.externalIp) === 4 ? "IPv4" : "IP",
    clipped(result.interface.externalIp, 48) || "不可用", clipped(result.interface.name, 32) || "不可用"].join(" / ");
  const lines = [
    `<blockquote><b>⚡ SPEEDTEST by OOKLA${escape(titleSuffix)}</b></blockquote>`,
    `<code>运营商</code> <code>${escape(isp)}</code>`,
    `<code>IP</code> <code>${escape(connection)}</code>`,
    `<code>服务器</code> <code>${result.server.id} / ${escape(clipped(result.server.name, 40))} / ${escape(clipped(result.server.location, 40))}</code>`,
    `<code>延迟</code> <code>${escape(number(result.ping?.latency, "ms"))}</code> <code>抖动 ${escape(number(result.ping?.jitter, "ms"))}</code>`,
    `<code>下行</code> <code>${escape(amount(result.download?.bandwidth, false))}</code> <code>${escape(amount(result.download?.bytes, true))}</code>`,
    `<code>上行</code> <code>${escape(amount(result.upload?.bandwidth, false))}</code> <code>${escape(amount(result.upload?.bytes, true))}</code>`,
    `<code>流量</code> <code>RX ${escape(traffic.rx === null ? "不可用" : amount(traffic.rx, true))}</code> <code>TX ${escape(traffic.tx === null ? "不可用" : amount(traffic.tx, true))}</code>`,
    `<code>MTU</code> <code>${escape(number(traffic.mtu))}</code>`,
    `<code>时间</code> <code>${escape(clipped(result.timestamp?.replace("T", " ").replace(/\.\d+Z$/, "Z") || "不可用", 40))}</code>`,
    `<code>结果</code> <code>${escape(clipped(resultUrl || "不可用", 180))}</code>`,
  ];
  if (!result.download || !result.upload) lines.push(`<code>说明</code> <code>${!result.download ? "下载" : "上传"}阶段失败，以上仅展示 CLI 返回的真实部分结果</code>`);
  return lines.join("\n");
}

async function downloadImage(context: PluginContext, source: URL, destination: string): Promise<void> {
  const image = new URL(source);
  image.pathname += ".png";
  await context.http.withResponse(image, {method: "GET"}, async (response, signal) => {
    if (response.status !== 200 || !response.body || !/^image\/png(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("invalid image");
    const reader = response.body.getReader();
    const output = await open(destination, "wx", 0o600);
    let total = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MAX_IMAGE_BYTES) throw new Error("image too large");
        await output.write(chunk.value);
      }
      if (!total) throw new Error("empty image");
    } finally {
      await output.close();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }, {timeoutMs: 20_000, redirects: {allowedHosts: ["www.speedtest.net"], maxRedirects: 0}});
}

async function sticker(context: PluginContext, source: string, destination: string): Promise<void> {
  const sharp = (await import("sharp")).default;
  await sharp(source).resize(512, 512, {fit: "contain", background: {r: 0, g: 0, b: 0, alpha: 0}})
    .webp({quality: 82, effort: 5}).toFile(destination);
  let info = await stat(destination);
  if (info.size > 512 * 1024) {
    await sharp(source).resize(512, 512, {fit: "contain", background: {r: 0, g: 0, b: 0, alpha: 0}})
      .webp({quality: 55, effort: 6}).toFile(destination);
    info = await stat(destination);
  }
  if (!info.isFile() || info.size === 0 || info.size > 512 * 1024) throw new Error("invalid sticker");
}

async function sendMedia(
  context: PluginContext,
  invocation: CommandInvocation,
  type: Exclude<MessageType, "txt">,
  image: string,
  body: string,
  caption: string,
  keepBody: boolean,
): Promise<boolean> {
  const raw = invocation.message.raw as {peerId?: unknown; delete?: (options?: unknown) => Promise<unknown>} | undefined;
  if (raw?.peerId === undefined || raw.peerId === null) return false;
  let sent = false;
  try {
    await context.telegram.withClient(async client => {
      context.signal.throwIfAborted();
      if (type === "sticker") {
        const output = path.join(path.dirname(image), "speedtest.webp");
        await sticker(context, image, output);
        const {Api} = await import("teleproto");
        await client.sendFile(raw.peerId as never, {file: output, forceDocument: false,
          attributes: [new Api.DocumentAttributeSticker({alt: "speedtest", stickerset: new Api.InputStickerSetEmpty()})],
          replyTo: invocation.message.replyToId ?? invocation.message.id});
      } else {
        await client.sendFile(raw.peerId as never, {file: image, caption, parseMode: "html",
          forceDocument: type === "file", replyTo: invocation.message.replyToId ?? invocation.message.id});
      }
      sent = true;
    });
    if (context.signal.aborted) return true;
    if (type === "sticker") await context.telegram.edit(invocation.message, body, {parseMode: "html", linkPreview: false});
    else if (!keepBody && typeof raw.delete === "function") await raw.delete({revoke: true}).catch(() => undefined);
    return true;
  } catch {
    if (context.signal.aborted) throw new Error("cancelled");
    context.log.error("speedtest_media_send_failed", {type});
    return sent;
  }
}

export async function deliverResult(
  context: PluginContext,
  invocation: CommandInvocation,
  result: SpeedtestResult,
  preferred: MessageType | null,
): Promise<void> {
  const report = await buildReport(context, result);
  const parts = reportParts(report, result);
  const order = messageOrder(preferred);
  if (order[0] === "txt") {
    await context.telegram.edit(invocation.message, parts.body, {parseMode: "html", linkPreview: false});
    return;
  }
  const source = officialResultUrl(result.result?.url);
  if (source) {
    try {
      const delivered = await context.files.withTemp(async (directory, signal) => {
        const image = path.join(directory, "speedtest.png");
        await downloadImage(context, source, image);
        for (const type of order) {
          signal.throwIfAborted();
          if (type === "txt") break;
          if (parts.separateBody) await context.telegram.edit(invocation.message, parts.body, {parseMode: "html", linkPreview: false});
          if (await sendMedia(context, invocation, type, image, parts.body, parts.caption, parts.separateBody)) return true;
        }
        return false;
      });
      if (delivered) return;
    } catch {
      if (context.signal.aborted) return;
      context.log.error("speedtest_result_image_failed");
    }
  }
  if (!context.signal.aborted) await context.telegram.edit(invocation.message, parts.body, {parseMode: "html", linkPreview: false});
}
