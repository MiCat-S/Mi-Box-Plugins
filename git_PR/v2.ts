import {definePlugin, type PluginContext} from "telebox/sdk";

const MASK = "••••••••";
type Config = {schemaVersion: number; git_email: string; git_username: string; git_token: string; git_api_base_url: string; [key: string]: unknown};
const defaults = (): Config => ({schemaVersion: 1, git_email: "", git_username: "", git_token: "", git_api_base_url: "https://api.github.com"});
const store = (context: PluginContext) => context.storage.json<Config>("config.json", defaults());
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function normalize(source: Config): Config {
  let base = typeof source.git_api_base_url === "string" ? source.git_api_base_url : defaults().git_api_base_url;
  try { const url = new URL(base); if (url.protocol !== "https:" || url.username || url.password) base = defaults().git_api_base_url; else base = url.href.replace(/\/$/, ""); }
  catch { base = defaults().git_api_base_url; }
  return {...source, schemaVersion: 1, git_email: String(source.git_email ?? ""), git_username: String(source.git_username ?? ""),
    git_token: String(source.git_token ?? ""), git_api_base_url: base};
}

function repo(value: string): [string, string] {
  const match = value.match(/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/);
  if (!match) throw new Error("仓库名格式应为 owner/repo");
  return [match[1]!, match[2]!];
}

async function api(context: PluginContext, config: Config, method: string, endpoint: string, body?: unknown): Promise<any> {
  if (!config.git_token) throw new Error("请先配置 Access Token");
  const base = new URL(config.git_api_base_url); const url = new URL(endpoint.replace(/^\//, ""), `${base.href.replace(/\/$/, "")}/`);
  if (url.origin !== base.origin) throw new Error("无效 API 路径");
  return context.http.withResponse(url, {method, credentials: "omit", headers: {Authorization: `Bearer ${config.git_token}`,
    Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "MiBot-Git-PR/2.0",
    "X-GitHub-Api-Version": "2022-11-28"}, body: body === undefined ? undefined : JSON.stringify(body)}, async (response, signal) => {
      const reader = response.body?.getReader(); const decoder = new TextDecoder(); const parts: string[] = []; let size = 0;
      try {
        if (reader) for (;;) { signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength; if (size > 2 * 1024 * 1024) throw new Error("API 返回内容过大"); parts.push(decoder.decode(chunk.value, {stream: true})); }
      } finally { if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); } }
      const text = parts.join("") + decoder.decode(); signal.throwIfAborted();
      let value: any = undefined; if (text) { try { value = JSON.parse(text); } catch { throw new Error("API 返回格式无效"); } }
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 401 || response.status === 403) throw new Error("认证失败或权限不足");
        if (response.status === 404) throw new Error("仓库或 PR 不存在");
        if (response.status === 409 || response.status === 405 || response.status === 422) throw new Error("PR 当前无法合并");
        throw new Error(`Git API 请求失败（${response.status}）`);
      }
      return value;
    }, {timeoutMs: 20_000, signal: context.signal, redirects: {allowedHosts: [base.hostname], maxRedirects: 2}});
}

async function output(invocation: any, context: PluginContext, text: string): Promise<void> {
  const parts: string[] = []; let current = "";
  for (const line of text.split("\n")) { if (`${current}${current ? "\n" : ""}${line}`.length > 3900) { if (current) parts.push(current); current = line; }
    else current += `${current ? "\n" : ""}${line}`; }
  if (current) parts.push(current);
  await context.telegram.edit(invocation.message, parts[0] || "", {parseMode: "html", linkPreview: false});
  for (const part of parts.slice(1)) await context.telegram.reply(invocation.message, part, {parseMode: "html", linkPreview: false});
}

const help = (prefix: string) => `<b>Git PR 管理</b>\n<code>${prefix}git login 邮箱 用户名 Token</code>\n` +
  `<code>${prefix}git repos</code>\n<code>${prefix}git prs owner/repo</code>\n` +
  `<code>${prefix}git merge owner/repo 编号</code>\n<code>${prefix}git mergeall owner/repo</code>`;

export default function createGitPr() {
  return definePlugin({apiVersion: 1, id: "git_PR", description: "通过 Git API 管理 Pull Request",
    async setup(context) { await store(context).update(normalize); },
    commands: {git: {description: "列出和合并 Git Pull Request", async handle(invocation: any, context: PluginContext) {
      const sub = (invocation.args[0] ?? "help").toLowerCase();
      if (["help", "h"].includes(sub)) { await output(invocation, context, help(invocation.prefix)); return; }
      if (!invocation.message.saved) { await context.telegram.edit(invocation.message, "Git Token 配置及 API 操作仅限在收藏夹中使用"); return; }
      try {
        if (sub === "login") {
          const [email, username, token] = invocation.args.slice(1);
          if (!email || !username || !token || token.length > 500) throw new Error("格式：git login 邮箱 用户名 Token");
          await store(context).update(source => ({...normalize(source), git_email: email, git_username: username, git_token: token}));
          await context.telegram.edit(invocation.message, "登录信息已保存"); return;
        }
        const config = normalize(await store(context).read());
        if (sub === "repos") {
          const values = await api(context, config, "GET", "/user/repos?per_page=100");
          if (!Array.isArray(values)) throw new Error("仓库列表格式无效");
          const names = values.filter(value => value?.permissions?.push || value?.permissions?.admin || value?.permissions?.maintain)
            .map(value => typeof value?.full_name === "string" ? value.full_name : "").filter(Boolean).slice(0, 100);
          await output(invocation, context, names.length ? `<b>有编辑权限的仓库</b>\n\n${names.map(value => `• <code>${escape(value)}</code>`).join("\n")}` : "未找到有编辑权限的仓库"); return;
        }
        if (sub === "prs") {
          const [owner, name] = repo(invocation.args[1] ?? "");
          const values = await api(context, config, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&per_page=50`);
          if (!Array.isArray(values)) throw new Error("PR 列表格式无效");
          const lines = values.slice(0, 50).map(value => `• <b>#${Number(value?.number) || 0}</b> ${escape(String(value?.title ?? "").slice(0, 500))}\n  作者：<code>${escape(value?.user?.login ?? "")}</code>`);
          await output(invocation, context, lines.length ? `<b>待处理的 PR</b>\n\n${lines.join("\n\n")}` : "没有待处理的 PR"); return;
        }
        if (sub === "merge") {
          const [owner, name] = repo(invocation.args[1] ?? ""); const number = Number(invocation.args[2]);
          if (!Number.isSafeInteger(number) || number < 1) throw new Error("PR 编号必须是正整数");
          const result = await api(context, config, "PUT", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/merge`, {});
          if (result?.merged !== true) throw new Error(String(result?.message || "PR 当前无法合并").slice(0, 300));
          await context.telegram.edit(invocation.message, `成功合并 PR #${number}`); return;
        }
        if (sub === "mergeall") {
          const [owner, name] = repo(invocation.args[1] ?? "");
          const values = await api(context, config, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&per_page=100`);
          if (!Array.isArray(values)) throw new Error("PR 列表格式无效");
          let success = 0; const failures: string[] = [];
          for (const item of values.slice().sort((a, b) => Number(a?.number) - Number(b?.number))) {
            context.signal.throwIfAborted(); const number = Number(item?.number);
            if (!Number.isSafeInteger(number) || number < 1) continue;
            try { const result = await api(context, config, "PUT", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/merge`, {});
              if (result?.merged !== true) throw new Error("not merged"); success++; }
            catch { failures.push(`#${number}`); }
          }
          await output(invocation, context, `<b>批量合并完成</b>\n成功：${success}\n失败：${failures.length}${failures.length ? `（${failures.join("、")}）` : ""}`); return;
        }
        await output(invocation, context, help(invocation.prefix));
      } catch (error) {
        if (context.signal.aborted) return;
        context.log.error("git_pr_failed");
        const message = error instanceof Error ? error.message : "操作失败";
        await context.telegram.edit(invocation.message, `操作失败：${escape(message.slice(0, 500))}`, {parseMode: "html"});
      }
    }}},
    settings: context => ({id: "git_PR", title: "Git PR 管理", description: "Git API 与访问令牌", category: "插件配置", icon: "🔀",
      getSchema: () => [{key: "git_token", label: "Access Token", type: "password", secret: true},
        {key: "git_api_base_url", label: "Git API 地址", type: "string", required: true}],
      getValues: async () => { const config = normalize(await store(context).read()); return {git_token: config.git_token ? MASK : "", git_api_base_url: config.git_api_base_url}; },
      setValues: async patch => { await store(context).update(source => normalize({...source,
        ...(typeof patch.git_token === "string" && patch.git_token && patch.git_token !== MASK ? {git_token: patch.git_token} : {}),
        ...(typeof patch.git_api_base_url === "string" ? {git_api_base_url: patch.git_api_base_url} : {})} as Config)); }}),
  });
}
