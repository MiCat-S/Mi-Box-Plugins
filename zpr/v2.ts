import { renderHelp as renderPluginHelp } from "./v2/help";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { definePlugin, type PluginContext } from "telebox/sdk";
import type { Api } from "teleproto";

class PartialDelivery extends Error {
  constructor(readonly delivered: number, readonly cleanupFailed = false) {
    super("PARTIAL_DELIVERY");
  }
}

const PROXIES = [
  "i.pximg.net",
  "i.pixiv.cat",
  "i.pixiv.re",
  "i.pixiv.nl",
] as const;
const MAX_IMAGE = 25 * 1024 * 1024;
type State = {
  schemaVersion: 1;
  proxyHost: string;
  legacyImported: boolean;
  [key: string]: unknown;
};
const DEFAULTS: State = {
  schemaVersion: 1,
  proxyHost: "i.pximg.net",
  legacyImported: false,
};
const store = (c: PluginContext) =>
  c.storage.json<State>("v2-config.json", DEFAULTS);
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>\"']/g,
    (x) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      })[x]!,
  );
const validProxy = (v: unknown): v is (typeof PROXIES)[number] =>
  typeof v === "string" && (PROXIES as readonly string[]).includes(v);
async function consume(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  chunk: (value: Uint8Array) => Promise<void> | void,
) {
  let cancellation: Promise<void> | undefined;
  const cancel = () =>
    (cancellation ??= (async () => {
      try {
        await reader.cancel();
      } catch {}
    })());
  const aborted = () => {
    void cancel();
  };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      await chunk(part.value);
      signal.throwIfAborted();
    }
  } finally {
    signal.removeEventListener("abort", aborted);
    await cancel();
    reader.releaseLock();
  }
}
async function responseJson(response: Response, signal: AbortSignal) {
  if (response.status !== 200) throw new Error("API 状态异常");
  const type = response.headers.get("content-type") ?? "";
  if (type && !type.toLowerCase().includes("json"))
    throw new Error("API 格式异常");
  if (Number(response.headers.get("content-length")) > 1024 * 1024)
    throw new Error("API 响应过大");
  if (!response.body) throw new Error("API 响应为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  await consume(response.body.getReader(), signal, (value) => {
    size += value.byteLength;
    if (size > 1024 * 1024) throw new Error("API 响应过大");
    chunks.push(value);
  });
  signal.throwIfAborted();
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}
function normalize(raw: unknown): State {
  const x =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const legacy = x.zpr_proxy_host;
  return {
    ...x,
    schemaVersion: 1,
    proxyHost: validProxy(x.proxyHost)
      ? x.proxyHost
      : validProxy(legacy)
        ? legacy
        : "i.pximg.net",
    legacyImported: x.legacyImported === true,
  };
}
async function migrate(c: PluginContext) {
  let rawDocument: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(
      await readFile(c.files.dataPath("v2-config.json"), {
        encoding: "utf8",
        signal: c.signal,
      }),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid");
    rawDocument = parsed;
  } catch (error) {
    c.signal.throwIfAborted();
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw new Error("ZPR_CONFIG_INVALID");
  }
  const document = await store(c).read();
  let value = normalize(document);
  c.signal.throwIfAborted();
  if (value.legacyImported) return value;
  const explicitProxy =
    !!rawDocument && Object.hasOwn(rawDocument, "proxyHost");
  {
    try {
      const raw = JSON.parse(
        await readFile(c.files.dataPath("zpr_config.json"), {
          encoding: "utf8",
          signal: c.signal,
        }),
      );
      c.signal.throwIfAborted();
      if (!explicitProxy) value.proxyHost = normalize(raw).proxyHost;
    } catch (error) {
      c.signal.throwIfAborted();
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw new Error("ZPR_LEGACY_CONFIG_INVALID");
    }
    value.legacyImported = true;
  }
  return store(c).update((current) => ({
    ...normalize(current),
    proxyHost: value.proxyHost,
    legacyImported: true,
  }));
}
function apiItem(value: unknown) {
  if (!value || typeof value !== "object") return;
  const x = value as any;
  if (
    !Number.isSafeInteger(x.pid) ||
    typeof x.title !== "string" ||
    !Number.isSafeInteger(x.width) ||
    !Number.isSafeInteger(x.height) ||
    !x.urls ||
    typeof x.urls.regular !== "string" ||
    typeof x.urls.original !== "string"
  )
    return;
  return {
    pid: x.pid as number,
    title: x.title.slice(0, 500) as string,
    width: x.width as number,
    height: x.height as number,
    regular: x.urls.regular as string,
    original: x.urls.original as string,
  };
}
function imageUrl(raw: string, proxy: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("图片地址无效");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.hash)
    throw new Error("图片地址无效");
  u.hostname = proxy;
  u.port = "";
  return u;
}
function publicUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("原图地址无效");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    !["pximg.net", "pixiv.net", "pixiv.cat", "pixiv.re", "pixiv.nl"].some(
      (h) => u.hostname === h || u.hostname.endsWith(`.${h}`),
    )
  )
    throw new Error("原图地址无效");
  return u.href;
}
async function image(
  c: PluginContext,
  url: URL,
  host: string,
  target: string,
  openFile: typeof open,
) {
  return c.http.withResponse(
    url,
    {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: {
        Accept: "image/*",
        "User-Agent": "MiBot-Zpr/2.0",
        ...(host === "i.pximg.net"
          ? { Referer: "https://www.pixiv.net/" }
          : {}),
      },
    },
    async (response, signal) => {
      if (response.status !== 200 || !response.body)
        throw new Error("图片不可用");
      const type = response.headers.get("content-type") ?? "";
      if (type && !type.toLowerCase().startsWith("image/"))
        throw new Error("图片格式无效");
      const reader = response.body.getReader();
      let handedOff = false;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let total = 0;
      try {
        signal.throwIfAborted();
        handle = await openFile(target, "wx", 0o600);
        signal.throwIfAborted();
        handedOff = true;
        await consume(reader, signal, async (value) => {
          total += value.byteLength;
          if (total > MAX_IMAGE) throw new Error("图片过大");
          let offset = 0;
          while (offset < value.byteLength) {
            signal.throwIfAborted();
            const { bytesWritten } = await handle!.write(
              value,
              offset,
              value.byteLength - offset,
            );
            signal.throwIfAborted();
            if (bytesWritten <= 0) throw new Error("图片写入失败");
            offset += bytesWritten;
          }
        });
        if (!total) throw new Error("图片为空");
      } finally {
        if (!handedOff) {
          try {
            await reader.cancel();
          } catch {}
          reader.releaseLock();
        }
        await handle?.close();
      }
    },
    {
      timeoutMs: 30_000,
      signal: c.signal,
      redirects: { allowedHosts: [host], maxRedirects: 2 },
    },
  );
}
async function download(
  c: PluginContext,
  item: NonNullable<ReturnType<typeof apiItem>>,
  preferred: string,
  target: string,
  openFile: typeof open,
) {
  for (const host of [preferred, ...PROXIES.filter((x) => x !== preferred)]) {
    c.signal.throwIfAborted();
    try {
      await image(c, imageUrl(item.regular, host), host, target, openFile);
      return host;
    } catch {
      c.signal.throwIfAborted();
      try {
        await (await import("node:fs/promises")).unlink(target);
      } catch {}
    }
  }
  throw new Error("图片下载失败");
}
type Dependencies = {
  openFile?: typeof open;
  withTemp?: (
    context: PluginContext,
    operation: (directory: string, signal: AbortSignal) => Promise<void>,
  ) => Promise<void>;
};

export default function createZpr(dependencies: Dependencies = {}) {
  const openFile = dependencies.openFile ?? open;
  return definePlugin({
    renderHelp: renderPluginHelp,
    apiVersion: 1,
    id: "zpr",
    description: "从 Lolicon API 获取随机 Pixiv 图片",
    commands: {
      zpr: {
        helpArgs: ["help", "h"],
        description: "随机纸片人图片",
        async handle(i, c) {
          const edit = (text: string, html = false) =>
            c.telegram.edit(
              i.message,
              text,
              html ? { parseMode: "html", linkPreview: false } : {},
            );
          try {
            const first = i.args[0]?.toLowerCase();
            if (first === "help" || first === "h") {
              await edit(renderPluginHelp(i.prefix), true);
              return;
            }
            let state = normalize(await store(c).read());
            if (first === "proxy") {
              if (!i.args[1]) {
                await edit(
                  `当前反代：${state.proxyHost}\n可用：${PROXIES.join("、")}`,
                );
                return;
              }
              if (!validProxy(i.args[1]))
                throw new Error("反代地址不在允许列表");
              state = await store(c).update((v) => ({
                ...normalize(v),
                proxyHost: i.args[1]!,
                legacyImported: true,
              }));
              await edit(`反代已更新：${state.proxyHost}`);
              return;
            }
            let count = 1,
              r18 = 0,
              tag = "";
            for (const arg of i.args) {
              if (arg.toLowerCase() === "r18") r18 = 1;
              else if (/^\d+$/u.test(arg))
                count = Math.min(10, Math.max(1, Number(arg)));
              else if (!tag) tag = arg.slice(0, 100);
            }
            await edit("正在获取图片…");
            const query = new URL("https://api.lolicon.app/setu/v2");
            for (const [k, v] of Object.entries({
              num: String(count),
              r18: String(r18),
              tag,
              size: "regular",
              proxy: state.proxyHost,
              excludeAI: "true",
            }))
              query.searchParams.append(k, v);
            query.searchParams.append("size", "original");
            const data = (await c.http.withResponse(
              query,
              {
                method: "GET",
                redirect: "manual",
                credentials: "omit",
                headers: {
                  Accept: "application/json",
                  "User-Agent": "MiBot-Zpr/2.0",
                },
              },
              responseJson,
              {
                timeoutMs: 10_000,
                signal: c.signal,
                redirects: {
                  allowedHosts: ["api.lolicon.app"],
                  maxRedirects: 2,
                },
              },
            )) as any;
            if (!Array.isArray(data?.data)) throw new Error("API 响应无效");
            const items = data.data
              .map(apiItem)
              .filter(Boolean)
              .slice(0, count) as NonNullable<ReturnType<typeof apiItem>>[];
            if (!items.length) throw new Error("未找到图片");
            let delivered = 0;
            try {
              await (dependencies.withTemp
                ? dependencies.withTemp(c, async (directory) => {
                    await produce(directory);
                  })
                : c.files.withTemp(async (directory) => {
                    await produce(directory);
                  }));
              async function produce(directory: string) {
                const results: {
                  item: NonNullable<ReturnType<typeof apiItem>>;
                  file: string;
                  host: string;
                }[] = [];
                for (const item of items) {
                  const file = path.join(directory, `${item.pid}.jpg`);
                  results.push({
                    item,
                    file,
                    host: await download(
                      c,
                      item,
                      state.proxyHost,
                      file,
                      openFile,
                    ),
                  });
                }
                const best = results.find(
                  (x) => x.host !== state.proxyHost,
                )?.host;
                if (best)
                  await store(c).update((v) => ({
                    ...normalize(v),
                    proxyHost: best,
                    legacyImported: true,
                  }));
                await c.telegram.withClient(async (client, clientSignal) => {
                  const signal = AbortSignal.any([c.signal, clientSignal]);
                  signal.throwIfAborted();
                  const raw = i.message.raw as Api.Message | undefined;
                  if (!raw?.peerId) throw new Error("消息上下文不可用");
                  for (const { item, file } of results) {
                    signal.throwIfAborted();
                    try {
                      const original = publicUrl(item.original);
                      await client.sendFile(raw.peerId, {
                        file,
                        caption: `<b>🎨 ${esc(item.title)}</b>\n🆔 <a href="https://www.pixiv.net/artworks/${item.pid}">${item.pid}</a>\n🔗 <a href="${esc(original)}">原图</a>\n📐 <code>${item.width}×${item.height}</code>`,
                        parseMode: "html",
                        spoiler: r18 === 1,
                        replyTo: i.message.replyToId,
                        topMsgId: i.message.topicId,
                      });
                      signal.throwIfAborted();
                      delivered++;
                    } catch (error) {
                      signal.throwIfAborted();
                      if (delivered) throw new PartialDelivery(delivered);
                      throw error;
                    }
                  }
                  if (typeof raw.delete === "function")
                    try {
                      await raw.delete({ revoke: true });
                      signal.throwIfAborted();
                    } catch (error) {
                      signal.throwIfAborted();
                      c.log.error("zpr_command_delete_failed");
                    }
                });
              }
            } catch (error) {
              c.signal.throwIfAborted();
              if (delivered) throw new PartialDelivery(delivered, delivered === items.length);
              throw error;
            }
          } catch (error) {
            if (c.signal.aborted) return;
            if (error instanceof PartialDelivery) {
              c.log.error("zpr_partial_delivery", {
                delivered: error.delivered,
              });
              await c.telegram.reply(
                i.message,
                error.cleanupFailed
                  ? `已发送 ${error.delivered} 张图片，临时文件清理未完成。`
                  : `已发送 ${error.delivered} 张图片，后续图片投递失败。`,
              );
              return;
            }
            c.log.error("zpr_failed");
            await edit("获取图片失败，请检查网络或稍后重试");
          }
        },
      },
    },
    settings: (c) => ({
      id: "zpr",
      title: "随机纸片人",
      description: "Lolicon 图片反代配置",
      category: "插件配置",
      icon: "🎨",
      getSchema: () => [
        {
          key: "proxyHost",
          label: "反代服务器",
          type: "select",
          options: PROXIES.map((value) => ({ value, label: value })),
        },
      ],
      getValues: async () => ({ proxyHost: (await store(c).read()).proxyHost }),
      async setValues(patch) {
        if (!validProxy(patch.proxyHost)) throw new Error("invalid proxy");
        await store(c).update((v) => ({
          ...normalize(v),
          proxyHost: patch.proxyHost as string,
          legacyImported: true,
        }));
      },
    }),
    async setup(c) {
      await migrate(c);
    },
  });
}
