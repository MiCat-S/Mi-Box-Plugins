import { generateChartConfig } from "./v2/chart";
import { createHmac } from "node:crypto";
import path from "node:path";
import { open, type FileHandle } from "node:fs/promises";
import {
  STRUCTURED_PLUGIN_API_VERSION,
  renderCommandHelp,
  type CommandDefinition,
  type CommandInvocation,
  definePlugin,
  ui,
  type MessageEnvelope,
  type PluginContext,
} from "telebox/sdk";
type Config = {
  schemaVersion: 1;
  url: string;
  secret: string;
  serviceMonitor: boolean;
  legacyImported: boolean;
  [key: string]: unknown;
};
type Server = {
  id: number;
  name: string;
  display_index?: number;
  last_active?: string;
  host?: any;
  state?: any;
  geoip?: any;
};
const defaults: Config = { schemaVersion: 1, url: "", secret: "", serviceMonitor: true, legacyImported: false };
const store = (c: PluginContext) => c.storage.json<Config>("config-v2.json", defaults);
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    x => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[x]!,
  );
class BusinessError extends Error {}
function root(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new BusinessError("面板地址无效");
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new BusinessError("面板地址无效");
  u.pathname = u.pathname.replace(/\/+$/, "");
  u.search = "";
  u.hash = "";
  return u;
}
const b64 = (v: string) => Buffer.from(v).toString("base64url");
function jwt(secret: string) {
  const now = Math.floor(Date.now() / 1000),
    h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    p = b64(JSON.stringify({ user_id: "1", orig_iat: now, exp: now + 3600, ip: "" }));
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}
async function get(c: PluginContext, config: Config, endpoint: string) {
  const u = root(config.url);
  u.pathname = `${u.pathname}${endpoint}`;
  return c.http.withResponse(
    u,
    { headers: { cookie: `nz-jwt=${jwt(config.secret)}`, "user-agent": "MiBot-Nezha/2", accept: "application/json" } },
    async (r, s) => {
      const active = AbortSignal.any([c.signal, s]),
        reader = r.body?.getReader();
      if (!reader) throw new Error("empty response");
      const chunks: Buffer[] = [];
      let total = 0,
        cancelling: Promise<void> | undefined;
      const cancel = () => {
        cancelling ??= reader.cancel().catch(() => {});
      };
      const abort = () => cancel();
      active.addEventListener("abort", abort, { once: true });
      if (active.aborted) cancel();
      try {
        for (;;) {
          active.throwIfAborted();
          const x = await reader.read();
          active.throwIfAborted();
          if (x.done) break;
          total += x.value.length;
          if (total > 2 * 1024 * 1024) throw new Error("response too large");
          chunks.push(Buffer.from(x.value));
        }
      } finally {
        active.removeEventListener("abort", abort);
        cancel();
        await cancelling;
        reader.releaseLock();
      }
      let data: any;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new Error("invalid response");
      }
      if (!r.ok || (data?.success !== true && !Array.isArray(data))) throw new Error("invalid response");
      return Array.isArray(data) ? data : data.data;
    },
    { timeoutMs: 15_000, redirects: { allowedHosts: [u.hostname], maxRedirects: 2 } },
  );
}
const bytes = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"],
    i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(2)} ${u[i]}`;
};
const online = (s: Server) => Boolean(s.last_active && Date.now() - new Date(s.last_active).getTime() < 60_000);
const SERVICE_CONCURRENCY = 6;
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  signal: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        signal.throwIfAborted();
        results[index] = await worker(items[index]!);
      }
    }),
  );
  return results;
}
function row(s: Server, services?: Map<string, number>) {
  const state = s.state ?? {},
    host = s.host ?? {},
    pct = (a: number, b: number) => (b ? Math.min(100, (a / b) * 100).toFixed(1) : "0.0");
  const monitors = services?.size
    ? `\n📶 ${[...services].map(([n, d]) => `${esc(n)}:${d.toFixed(1)}ms`).join(" | ")}`
    : "";
  if (!online(s)) return `🔴 <b>${esc(s.name)}</b> <code>#${s.id}</code>${monitors}`;
  return `🟢 <b>${esc(s.name)}</b> <code>#${s.id}</code>${monitors}\n<blockquote>CPU ${Number(state.cpu ?? 0).toFixed(1)}% · 内存 ${pct(state.mem_used, host.mem_total)}% · 硬盘 ${pct(state.disk_used, host.disk_total)}%\n网络 ↑${bytes(state.net_out_speed ?? 0)}/s ↓${bytes(state.net_in_speed ?? 0)}/s · 运行 ${Math.floor((state.uptime ?? 0) / 86400)} 天</blockquote>`;
}
async function services(c: PluginContext, config: Config, id: number) {
  const result = new Map<string, number>();
  try {
    const data = await get(c, config, `/api/v1/service/${id}`);
    if (Array.isArray(data))
      for (const x of data) {
        const delay = Array.isArray(x?.avg_delay) ? Number(x.avg_delay.at(-1)) : NaN;
        if (typeof x?.monitor_name === "string" && Number.isFinite(delay)) result.set(x.monitor_name, delay);
      }
  } catch {
    c.signal.throwIfAborted();
  }
  return result;
}
async function list(c: PluginContext, config: Config) {
  const data = await get(c, config, "/api/v1/server");
  if (!Array.isArray(data)) throw new Error("服务器列表结构异常");
  const servers = data.filter((x: any) => Number.isSafeInteger(x?.id) && typeof x?.name === "string") as Server[];
  const maps = new Map<number, Map<string, number>>();
  if (config.serviceMonitor) {
    const monitored = servers.filter(online);
    const results = await mapLimit(monitored, SERVICE_CONCURRENCY, s => services(c, config, s.id), c.signal);
    monitored.forEach((s, index) => maps.set(s.id, results[index]!));
  }
  servers.sort((a, b) => Number(online(b)) - Number(online(a)) + (a.display_index ?? 0) - (b.display_index ?? 0));
  const count = servers.filter(online).length;
  const pages = await ui.renderDocument(
    {
      title: "📊 哪吒监控",
      subtitle: `${count}/${servers.length} 在线 · 服务监控${config.serviceMonitor ? "开" : "关"}`,
      sections: [
        ui.section(
          undefined,
          servers.map(s => row(s, maps.get(s.id)) as unknown as ui.Html),
        ),
      ],
    },
    ui.PAGE_LABEL_RESERVE,
  );
  return pages.map((page, index) => page + ui.pageLabel(index, pages.length));
}
async function chart(c: PluginContext, m: MessageEnvelope, config: Config, target: string) {
  const all = await get(c, config, "/api/v1/server");
  if (!Array.isArray(all)) throw new Error("服务器列表结构异常");
  const query = target.toLowerCase(),
    server = (all as Server[]).find(s => String(s.id) === target || s.name.toLowerCase().includes(query));
  if (!server) throw new BusinessError("未找到服务器");
  const monitor = await get(c, config, `/api/v1/service/${server.id}`);
  if (!Array.isArray(monitor) || !monitor.length) throw new BusinessError("没有服务监控数据");
  const body = {
    chart: generateChartConfig(monitor, server.name),
    width: 800,
    height: 400,
    backgroundColor: "black",
    format: "png",
  };
  const u = new URL("https://quickchart.io/chart");
  await c.files.withTemp(async (dir, signal) => {
    const file = path.join(dir, "chart.png");
    await c.http.withResponse(
      u,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      async (r, s) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const active = AbortSignal.any([c.signal, signal, s]),
          reader = r.body?.getReader();
        if (!reader) throw new Error("图表响应为空");
        let handle: FileHandle | undefined,
          total = 0,
          cancelling: Promise<void> | undefined;
        const cancel = () => {
            cancelling ??= reader.cancel().catch(() => {});
          },
          abort = () => cancel();
        active.addEventListener("abort", abort, { once: true });
        if (active.aborted) cancel();
        try {
          handle = await open(file, "wx");
          for (;;) {
            active.throwIfAborted();
            const x = await reader.read();
            active.throwIfAborted();
            if (x.done) break;
            total += x.value.length;
            if (total > 4 * 1024 * 1024) throw new Error("图表过大");
            await handle.writeFile(x.value);
            active.throwIfAborted();
          }
        } finally {
          active.removeEventListener("abort", abort);
          cancel();
          await cancelling;
          try {
            await handle?.close();
          } finally {
            reader.releaseLock();
          }
        }
      },
      { timeoutMs: 30_000, redirects: { allowedHosts: ["quickchart.io"], maxRedirects: 1 } },
    );
    signal.throwIfAborted();
    await c.telegram.withClient(async (client, clientSignal) => {
      const active = AbortSignal.any([c.signal, signal, clientSignal]);
      active.throwIfAborted();
      await client.sendFile((m.raw as any)?.peerId ?? m.chatId, {
        file,
        caption: `${server.name} 服务延迟`,
        replyTo: m.id,
      });
      active.throwIfAborted();
    });
  });
}
async function migrate(c: PluginContext) {
  const { readFile } = await import("node:fs/promises"),
    read = async (name: string) => {
      c.signal.throwIfAborted();
      try {
        const value = JSON.parse(await readFile(c.files.dataPath(name), { encoding: "utf8", signal: c.signal }));
        c.signal.throwIfAborted();
        if (value === null || typeof value !== "object" || Array.isArray(value))
          throw new Error("Invalid Nezha configuration root");
        return value;
      } catch (e) {
        c.signal.throwIfAborted();
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw e;
      }
    };
  const persisted = await read("config-v2.json");
  if (persisted.legacyImported === true) return;
  const legacy = await read("config.json"),
    has = (key: string) => Object.hasOwn(persisted, key);
  await store(c).update(v => ({
    ...v,
    url: has("url") ? String(persisted.url ?? "") : String(legacy.url ?? v.url),
    secret: has("secret") ? String(persisted.secret ?? "") : String(legacy.secret ?? v.secret),
    serviceMonitor: has("serviceMonitor")
      ? typeof persisted.serviceMonitor === "boolean"
        ? persisted.serviceMonitor
        : v.serviceMonitor
      : typeof legacy.serviceMonitor === "boolean"
        ? legacy.serviceMonitor
        : v.serviceMonitor,
    legacyImported: true,
  }));
}
const guarded =
  (operation: CommandDefinition["handle"]): CommandDefinition["handle"] =>
  async (i, c) => {
    try {
      await operation(i, c);
    } catch (e) {
      if (!c.signal.aborted)
        await c.telegram.edit(
          i.message,
          `❌ ${esc(e instanceof BusinessError ? e.message : "哪吒请求失败，请稍后重试")}`,
          { parseMode: "html" },
        );
    }
  };
const configured = (
  operation: (i: CommandInvocation, c: PluginContext, config: Config) => Promise<void>,
): CommandDefinition["handle"] =>
  guarded(async (i, c) => {
    const config = await store(c).read();
    if (!config.url || !config.secret) throw new BusinessError("请先配置哪吒地址和 JWT Secret");
    await operation(i, c, config);
  });
const service = (enabled: boolean): CommandDefinition["handle"] =>
  configured(async (i, c) => {
    await store(c).update(v => ({ ...v, serviceMonitor: enabled }));
    await c.telegram.edit(i.message, "服务监控设置已更新。");
  });
const command: CommandDefinition = {
  description: "查询或配置哪吒监控",
  helpArgs: ["help", "h"],
  args: "",
  subcommandsCaseSensitive: false,
  examples: [{ args: "", description: "查看全部服务器，在线服务器优先，长列表自动分页" }],
  subcommands: {
    set: {
      description: "验证并保存面板连接配置",
      args: "面板地址 JWT_SECRET",
      examples: [{ args: "set https://nezha.example.com your_jwt_secret" }],
      help: [
        {
          heading: "首次配置：",
          body: "在收藏夹设置面板地址与面板配置的 jwt_secret_key 原始值。先验证 /api/v1/server 接口，成功后保存，保留服务延迟显示开关。",
        },
      ],
      async authorize(i, c) {
        if (i.message.saved) return true;
        if (!c.signal.aborted) await c.telegram.edit(i.message, "❌ 密钥配置仅限收藏夹", { parseMode: "html" });
        return false;
      },
      handle: guarded(async (i, c) => {
        if (!i.args[0] || !i.args[1]) throw new BusinessError("用法：nezha set URL JWT_SECRET");
        root(i.args[0]);
        const candidate = {
          ...(await store(c).read()),
          url: i.args[0].replace(/\/+$/, ""),
          secret: i.args.slice(1).join(" "),
        };
        await get(c, candidate, "/api/v1/server");
        await store(c).update(v => ({ ...v, url: candidate.url, secret: candidate.secret }));
        await c.telegram.edit(i.message, "哪吒配置已验证并保存。");
      }),
    },
    service: {
      description: "设置列表中的服务延迟显示，默认开启",
      subcommandsCaseSensitive: true,
      subcommands: {
        on: { description: "开启服务延迟显示", args: "", handle: service(true) },
        off: { description: "关闭服务延迟显示", args: "", handle: service(false) },
      },
      examples: [{ args: "service off" }],
      handle: configured(async (i, c, config) => {
        await c.telegram.edit(
          i.message,
          `📶 服务监控当前状态: <b>${config.serviceMonitor ? "开启" : "关闭"}</b>\n\n用法: <code>${esc(i.prefix)}nezha service on/off</code>`,
          { parseMode: "html" },
        );
      }),
    },
    chart: {
      description: "生成指定服务器的服务延迟图表",
      args: "服务器名或ID",
      examples: [{ args: "chart 1" }, { args: "chart 香港节点" }],
      help: [
        {
          heading: "图表数据：",
          body: "通过 QuickChart 生成图表，相关图表数据会发送到 quickchart.io。服务器须存在服务监控记录。",
        },
      ],
      handle: configured(async (i, c, config) => {
        await c.telegram.edit(i.message, "正在获取哪吒监控数据…");
        if (!i.args.length) throw new BusinessError("请提供服务器名称或 ID");
        await chart(c, i.message, config, i.args.join(" "));
      }),
    },
  },
  help: [
    {
      heading: "配置与数据范围：",
      body: "面板使用 HTTP/HTTPS 地址，可包含部署子路径；需提供 /api/v1/server 与服务监控接口并接受 JWT 认证。连接配置在各对话间共用，也可通过插件设置填写面板地址和 JWT Secret。",
    },
    {
      heading: "常见提示：",
      body: "未配置时先在收藏夹完成 set；HTTP 或验证失败时检查面板地址、JWT Secret 和接口兼容性；图表缺少数据时核对服务器名/ID 与服务监控记录。",
    },
  ],
  handle: configured(async (i, c, config) => {
    const m = i.message;
    await c.telegram.edit(m, "正在获取哪吒监控数据…");
    const pages = await list(c, config);
    const delivery = await ui.deliverPages(pages, c.signal, (page, index) =>
      index ? c.telegram.reply(m, page, { parseMode: "html" }) : c.telegram.edit(m, page, { parseMode: "html" }),
    );
    if (delivery.interrupted) {
      c.log.info("pagination_delivery_interrupted", {
        plugin: "nezha",
        published: delivery.published,
        total: delivery.total,
        category: ui.deliveryErrorCategory(delivery.error),
      });
      if (!delivery.published) throw delivery.error;
      try {
        await c.telegram.reply(m, ui.interruptedNotice(delivery), { parseMode: "html" });
      } catch {}
    }
  }),
};
const help = (prefix: string) => renderCommandHelp("nezha", command, { prefix, title: "📊 哪吒监控" });
export default function createNezha() {
  return definePlugin({
    renderHelp: help,
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "nezha",
    description: "查询哪吒监控服务器与服务延迟",
    commands: { nezha: command },
    settings: c => ({
      id: "nezha",
      title: "哪吒监控",
      category: "插件配置",
      icon: "📊",
      getSchema: () => [
        { key: "url", label: "面板地址", type: "string" },
        { key: "secret", label: "JWT Secret", type: "password", secret: true },
        { key: "serviceMonitor", label: "服务监控", type: "boolean" },
      ],
      getValues: async () => {
        const v = await store(c).read();
        return { url: v.url, secret: v.secret, serviceMonitor: v.serviceMonitor };
      },
      async setValues(p) {
        await store(c).update(v => {
          const url = typeof p.url === "string" ? p.url : v.url;
          if (url) root(url);
          return {
            ...v,
            url,
            secret: typeof p.secret === "string" ? p.secret : v.secret,
            serviceMonitor: typeof p.serviceMonitor === "boolean" ? p.serviceMonitor : v.serviceMonitor,
          };
        });
      },
    }),
    setup: migrate,
  });
}
