import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, ui, type PluginContext} from "telebox/sdk";

const MASK = "••••••••";
class BusinessError extends Error {}
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
  if (!match) throw new BusinessError("仓库名格式应为 owner/repo");
  return [match[1]!, match[2]!];
}

async function api(context: PluginContext, config: Config, method: string, endpoint: string, body?: unknown): Promise<any> {
  if (!config.git_token) throw new BusinessError("请先配置 Access Token");
  const base = new URL(config.git_api_base_url); const url = new URL(endpoint.replace(/^\//, ""), `${base.href.replace(/\/$/, "")}/`);
  if (url.origin !== base.origin) throw new BusinessError("无效 API 路径");
  const result = await context.http.withResponse(url, {method, credentials: "omit", headers: {Authorization: `Bearer ${config.git_token}`,
    Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "MiBot-Git-PR/2.0",
    "X-GitHub-Api-Version": "2022-11-28"}, body: body === undefined ? undefined : JSON.stringify(body)}, async (response, signal) => {
      const reader = response.body?.getReader(); const decoder = new TextDecoder(); const parts: string[] = []; let size = 0;
      let cancelPromise: Promise<void> | undefined;
      const cancel = (): Promise<void> => cancelPromise ??= reader ? reader.cancel() : Promise.resolve();
      const onAbort = (): void => { void cancel(); };
      signal.addEventListener("abort", onAbort, {once: true});
      try {
        if (reader) for (;;) { signal.throwIfAborted(); const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
          size += chunk.value.byteLength; if (size > 2 * 1024 * 1024) return {error: "API 返回内容过大"}; parts.push(decoder.decode(chunk.value, {stream: true})); }
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (reader) try { await cancel(); } finally { reader.releaseLock(); }
      }
      const text = parts.join("") + decoder.decode(); signal.throwIfAborted();
      let value: any = undefined; if (text) { try { value = JSON.parse(text); } catch { return {error: "API 返回格式无效"}; } }
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 401 || response.status === 403) return {error: "认证失败或权限不足"};
        if (response.status === 404) return {error: "仓库或 PR 不存在"};
        if (response.status === 409 || response.status === 405 || response.status === 422) return {error: "PR 当前无法合并"};
        return {error: `Git API 请求失败（${response.status}）`};
      }
      return {value};
    }, {timeoutMs: 20_000, signal: context.signal, redirects: {allowedHosts: [base.hostname], maxRedirects: 2}});
  if (result.error) throw new BusinessError(result.error);
  return result.value;
}

async function output(invocation: any, context: PluginContext, text: string): Promise<void> {
  const pages = (await ui.renderRichText(text, ui.PAGE_LABEL_RESERVE))
    .map((page, index, all) => page + ui.pageLabel(index, all.length));
  const delivery = await ui.deliverPages(pages, context.signal, (page, index) => index
    ? context.telegram.reply(invocation.message, page, {parseMode: "html", linkPreview: false})
    : context.telegram.edit(invocation.message, page, {parseMode: "html", linkPreview: false}));
  if (!delivery.interrupted) return;
  context.log.info("pagination_delivery_interrupted", {plugin: "git_PR", published: delivery.published,
    total: delivery.total, category: ui.deliveryErrorCategory(delivery.error)});
  if (!delivery.published) throw delivery.error;
  try { await context.telegram.reply(invocation.message, ui.interruptedNotice(delivery), {parseMode: "html"}); } catch {}
}

const help = (prefix: string) => `<b>Git PR 管理</b>\n<code>${escape(prefix)}git login 邮箱 用户名 Token</code>\n` +
  `<code>${escape(prefix)}git repos</code>\n<code>${escape(prefix)}git prs owner/repo</code>\n` +
  `<code>${escape(prefix)}git merge owner/repo 编号</code>\n<code>${escape(prefix)}git mergeall owner/repo</code>`;

export default function createGitPr() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "git_PR", description: "通过 Git API 管理 Pull Request",
    async setup(context) { await store(context).update(normalize); },
    commands: {git: {helpArgs: ["help","h"], helpOnEmpty: true, description: "列出和合并 Git Pull Request", async handle(invocation: any, context: PluginContext) {
      const sub = (invocation.args[0] ?? "help").toLowerCase();
      if (["help", "h"].includes(sub)) { await output(invocation, context, help(invocation.prefix)); return; }
      let mutationCompleted = false;
      try {
        if (sub === "login") {
          if (!invocation.message.saved) { await context.telegram.edit(invocation.message, "Git Token 仅限在收藏夹中设置"); return; }
          const [email, username, token] = invocation.args.slice(1);
          if (!email || !username || !token || token.length > 500) throw new BusinessError("格式：git login 邮箱 用户名 Token");
          await store(context).update(source => ({...normalize(source), git_email: email, git_username: username, git_token: token}));
          await context.telegram.edit(invocation.message, "登录信息已保存"); return;
        }
        const config = normalize(await store(context).read());
        if (sub === "repos") {
          const values = await api(context, config, "GET", "/user/repos?per_page=100");
          if (!Array.isArray(values)) throw new BusinessError("仓库列表格式无效");
          const names = values.filter(value => value?.permissions?.push || value?.permissions?.admin || value?.permissions?.maintain)
            .map(value => typeof value?.full_name === "string" ? value.full_name : "").filter(Boolean).slice(0, 100);
          await output(invocation, context, names.length ? `<b>有编辑权限的仓库</b>\n\n${names.map(value => `• <code>${escape(value)}</code>`).join("\n")}` : "未找到有编辑权限的仓库"); return;
        }
        if (sub === "prs") {
          const [owner, name] = repo(invocation.args[1] ?? "");
          const values = await api(context, config, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&per_page=50`);
          if (!Array.isArray(values)) throw new BusinessError("PR 列表格式无效");
          const lines: string[] = [];
          for (const value of values.slice(0, 50)) {
            context.signal.throwIfAborted();
            const number = Number(value?.number); let mergeable: boolean | undefined; let state = "";
            if (Number.isSafeInteger(number) && number > 0) {
              try { const detail = await api(context, config, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`);
                mergeable = typeof detail?.mergeable === "boolean" ? detail.mergeable : undefined;
                state = typeof detail?.mergeable_state === "string" ? detail.mergeable_state.slice(0, 80) : "";
              } catch { context.signal.throwIfAborted(); }
            }
            const status = mergeable === true ? "✅ 可合并" : mergeable === false ? `⛔ 不可合并（${escape(state || "unknown")}）` : "❓ 未知";
            lines.push(`• <b>#${Number.isSafeInteger(number) ? number : 0}</b> ${escape(String(value?.title ?? "").slice(0, 500))}\n  作者：<code>${escape(value?.user?.login ?? "")}</code> | 状态：${status}`);
          }
          await output(invocation, context, lines.length ? `<b>待处理的 PR</b>\n\n${lines.join("\n\n")}` : "没有待处理的 PR"); return;
        }
        if (sub === "merge") {
          const [owner, name] = repo(invocation.args[1] ?? ""); const number = Number(invocation.args[2]);
          if (!Number.isSafeInteger(number) || number < 1) throw new BusinessError("PR 编号必须是正整数");
          const result = await api(context, config, "PUT", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/merge`, {});
          if (result?.merged !== true) throw new BusinessError("PR 当前无法合并");
          mutationCompleted = true;
          await context.telegram.edit(invocation.message, `成功合并 PR #${number}`); return;
        }
        if (sub === "mergeall") {
          const [owner, name] = repo(invocation.args[1] ?? "");
          const values = await api(context, config, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&per_page=100`);
          if (!Array.isArray(values)) throw new BusinessError("PR 列表格式无效");
          const mergeable: any[] = [];
          for (const item of values) {
            context.signal.throwIfAborted(); const number = Number(item?.number);
            if (!Number.isSafeInteger(number) || number < 1) continue;
            try { const detail = await api(context, config, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`);
              if (detail?.mergeable === true) mergeable.push(item); } catch { context.signal.throwIfAborted(); }
          }
          if (!mergeable.length) { await context.telegram.edit(invocation.message, `仓库 <code>${escape(`${owner}/${name}`)}</code> 中没有可自动合并的 PR`, {parseMode: "html"}); return; }
          let success = 0; const failures: string[] = [];
          for (const item of mergeable.sort((a, b) => Number(a?.number) - Number(b?.number))) {
            context.signal.throwIfAborted(); const number = Number(item.number);
            try { const result = await api(context, config, "PUT", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/merge`, {});
              if (result?.merged !== true) throw new Error("not merged"); success++; }
            catch { failures.push(`#${number}`); }
          }
          mutationCompleted = true;
          await output(invocation, context, `<b>批量合并完成</b>\n成功：${success}\n失败：${failures.length}${failures.length ? `（${failures.join("、")}）` : ""}`); return;
        }
        await output(invocation, context, help(invocation.prefix));
      } catch (error) {
        if (context.signal.aborted) return;
        context.log.error("git_pr_failed");
        if (mutationCompleted) return;
        const message = error instanceof BusinessError ? `操作失败：${escape(error.message)}` : "操作失败，请稍后重试";
        try { await context.telegram.edit(invocation.message, message, {parseMode: "html"}); } catch {}
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
