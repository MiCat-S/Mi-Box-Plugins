import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type PluginContext, type SubcommandDefinition} from "telebox/sdk";

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

export default function createGitPr() {
  const guard = (operation: (invocation: any, context: PluginContext) => Promise<void>) => async (invocation: any, context: PluginContext) => {
    try { await operation(invocation, context); }
    catch (error) {
      if (context.signal.aborted) return;
      context.log.error("git_pr_failed");
      const message = error instanceof Error ? error.message : "操作失败";
      await context.telegram.edit(invocation.message, `操作失败：${escape(message.slice(0, 500))}`, {parseMode: "html"});
    }
  };
  const login: SubcommandDefinition = {
    description: "登录 Git（仅收藏夹）", args: "邮箱 用户名 Token",
    arguments: [{name: "邮箱", required: true}, {name: "用户名", required: true}, {name: "Token", required: true, description: "最长 500 字符"}],
    examples: [{args: "login me@example.com octocat ghp_xxx"}],
    handle: guard(async (invocation, context) => {
      if (!invocation.message.saved) { await context.telegram.edit(invocation.message, "Git Token 仅限在收藏夹中设置"); return; }
      const [email, username, token] = invocation.args;
      if (!email || !username || !token || token.length > 500) throw new Error("格式：git login 邮箱 用户名 Token");
      await store(context).update(source => ({...normalize(source), git_email: email, git_username: username, git_token: token}));
      await context.telegram.edit(invocation.message, "登录信息已保存");
    }),
  };
  const repos: SubcommandDefinition = {
    description: "列出有编辑权限的仓库", args: "", examples: [{args: "repos"}],
    handle: guard(async (invocation, context) => {
      const config = normalize(await store(context).read());
      const values = await api(context, config, "GET", "/user/repos?per_page=100");
      if (!Array.isArray(values)) throw new Error("仓库列表格式无效");
      const names = values.filter(value => value?.permissions?.push || value?.permissions?.admin || value?.permissions?.maintain)
        .map(value => typeof value?.full_name === "string" ? value.full_name : "").filter(Boolean).slice(0, 100);
      await output(invocation, context, names.length ? `<b>有编辑权限的仓库</b>\n\n${names.map(value => `• <code>${escape(value)}</code>`).join("\n")}` : "未找到有编辑权限的仓库");
    }),
  };
  const prs: SubcommandDefinition = {
    description: "列出仓库的 PR", args: "owner/repo", arguments: [{name: "owner/repo", required: true}],
    examples: [{args: "prs octocat/Hello-World"}],
    handle: guard(async (invocation, context) => {
      const config = normalize(await store(context).read());
      const [owner, name] = repo(invocation.args[0] ?? "");
      const values = await api(context, config, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&per_page=50`);
      if (!Array.isArray(values)) throw new Error("PR 列表格式无效");
      const lines = values.slice(0, 50).map(value => `• <b>#${Number(value?.number) || 0}</b> ${escape(String(value?.title ?? "").slice(0, 500))}\n  作者：<code>${escape(value?.user?.login ?? "")}</code>`);
      await output(invocation, context, lines.length ? `<b>待处理的 PR</b>\n\n${lines.join("\n\n")}` : "没有待处理的 PR");
    }),
  };
  const merge: SubcommandDefinition = {
    description: "合并 PR", args: "owner/repo 编号",
    arguments: [{name: "owner/repo", required: true}, {name: "编号", required: true, description: "正整数"}],
    examples: [{args: "merge octocat/Hello-World 42"}],
    handle: guard(async (invocation, context) => {
      const config = normalize(await store(context).read());
      const [owner, name] = repo(invocation.args[0] ?? ""); const number = Number(invocation.args[1]);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error("PR 编号必须是正整数");
      const result = await api(context, config, "PUT", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/merge`, {});
      if (result?.merged !== true) throw new Error(String(result?.message || "PR 当前无法合并").slice(0, 300));
      await context.telegram.edit(invocation.message, `成功合并 PR #${number}`);
    }),
  };
  const mergeall: SubcommandDefinition = {
    description: "按序号合并所有可合并的 PR", args: "owner/repo", arguments: [{name: "owner/repo", required: true}],
    examples: [{args: "mergeall octocat/Hello-World"}],
    handle: guard(async (invocation, context) => {
      const config = normalize(await store(context).read());
      const [owner, name] = repo(invocation.args[0] ?? "");
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
      await output(invocation, context, `<b>批量合并完成</b>\n成功：${success}\n失败：${failures.length}${failures.length ? `（${failures.join("、")}）` : ""}`);
    }),
  };
  const gitCommand: CommandDefinition = {
    description: "列出和合并 Git Pull Request",
    helpArgs: ["help", "h"],
    helpOnEmpty: true,
    subcommandsCaseSensitive: false,
    subcommands: {login, repos, prs, merge, mergeall},
    examples: [{args: "login 邮箱 用户名 Token"}, {args: "repos"}, {args: "prs owner/repo"}, {args: "merge owner/repo 42"}, {args: "mergeall owner/repo"}],
    help: [
      {heading: "说明：", body: "通过 GitHub 兼容 API 管理 Pull Request；登录信息仅限收藏夹设置。可配置自定义 Git API 地址。"},
      {heading: "密钥配置：", body: "涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。"},
    ],
    async handle(invocation, context) {
      const sub = (invocation.args[0] ?? "help").toLowerCase();
      const show = () => output(invocation, context, renderCommandHelp("git", gitCommand, {prefix: invocation.prefix, title: "⚙️ Git PR 管理插件"}));
      if (sub === "help" || sub === "h") { await show(); return; }
      await guard(async () => { await store(context).read(); await show(); })(invocation, context);
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "git_PR", description: "通过 Git API 管理 Pull Request",
    async setup(context) { await store(context).update(normalize); },
    renderHelp: prefix => renderCommandHelp("git", gitCommand, {prefix, title: "⚙️ Git PR 管理插件"}),
    commands: {git: gitCommand},
    settings: context => ({id: "git_PR", title: "Git PR 管理", description: "Git API 与访问令牌", category: "插件配置", icon: "🔀",
      getSchema: () => [{key: "git_token", label: "Access Token", type: "password", secret: true},
        {key: "git_api_base_url", label: "Git API 地址", type: "string", required: true}],
      getValues: async () => { const config = normalize(await store(context).read()); return {git_token: config.git_token ? MASK : "", git_api_base_url: config.git_api_base_url}; },
      setValues: async patch => { await store(context).update(source => normalize({...source,
        ...(typeof patch.git_token === "string" && patch.git_token && patch.git_token !== MASK ? {git_token: patch.git_token} : {}),
        ...(typeof patch.git_api_base_url === "string" ? {git_api_base_url: patch.git_api_base_url} : {})} as Config)); }}),
  });
}
