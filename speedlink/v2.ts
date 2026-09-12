import {access, open, readFile, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {
  STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp,
  type CommandDefinition, type CommandInvocation, type PluginContext, type SubcommandDefinition, ui,
} from "telebox/sdk";
import {DEFAULTS, MAX_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS, normalizeServer, normalizeState, parseConnection, parseTimeout, selectServer,
  type Server, type State} from "./v2/config";
import {writeAll} from "./v2/io";
import {dependencies, runLocal, runRemote, type SpeedResult} from "./v2/runner";

const store = (ctx: PluginContext) => ctx.storage.json<State>("v2-config.json", DEFAULTS);
const ALL_TIMEOUT_MS = 30 * 60_000;
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[character]!);

async function state(ctx: PluginContext): Promise<State> {
  return normalizeState(await store(ctx).read(ctx.signal));
}

async function update(ctx: PluginContext, change: (value: State) => State): Promise<State> {
  return store(ctx).update(value => normalizeState(change(normalizeState(value))), ctx.signal);
}

async function deliverPages(ctx: PluginContext, invocation: CommandInvocation, content: string): Promise<void> {
  const pages = (await ui.renderRichText(content, ui.PAGE_LABEL_RESERVE))
    .map((page, index, all) => page + ui.pageLabel(index, all.length));
  const delivery = await ui.deliverPages(pages, ctx.signal, (page, index) => index
    ? ctx.telegram.reply(invocation.message, page, {parseMode: "html"})
    : ctx.telegram.edit(invocation.message, page, {parseMode: "html", linkPreview: false}));
  if (!delivery.interrupted) return;
  ctx.log.info("pagination_delivery_interrupted", {plugin: "speedlink", published: delivery.published, total: delivery.total,
    category: ui.deliveryErrorCategory(delivery.error)});
  if (!delivery.published) throw delivery.error;
  try { await ctx.telegram.reply(invocation.message, ui.interruptedNotice(delivery), {parseMode: "html"}); } catch {}
}

function rate(bandwidth: number | undefined): string {
  return bandwidth === undefined ? "失败" : `${Math.round(bandwidth * 8 / 10_000) / 100} Mbps`;
}

function report(result: SpeedResult, label: string): string {
  return `<b>⚡ ${escape(label)}</b>\n节点：<code>${escape(result.server.id)} / ${escape(result.server.name)} / ${escape(result.server.location)}</code>\n` +
    `运营商：<code>${escape(result.isp || "未知")}</code>\n延迟：<code>${result.ping ? `${result.ping.latency} ms` : "失败"}</code>\n` +
    `下行：<code>${rate(result.download?.bandwidth)}</code>\n上行：<code>${rate(result.upload?.bandwidth)}</code>`;
}

async function downloadImage(ctx: PluginContext, resultUrl: string, target: string): Promise<void> {
  const source = new URL(`${resultUrl}.png`);
  if (source.protocol !== "https:" || source.hostname !== "www.speedtest.net" || !/^\/result\/[A-Za-z0-9._-]+\.png$/u.test(source.pathname)) {
    throw new Error("测速结果图片地址无效");
  }
  await ctx.http.withResponse(source, {method: "GET", credentials: "omit", headers: {Accept: "image/png"}}, async (response, signal) => {
    if (!response.ok || !response.body || !/^image\/png(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) throw new Error("测速结果图片不可用");
    const reader = response.body.getReader(); let handle: Awaited<ReturnType<typeof open>> | undefined; let total = 0;
    try {
      handle = await open(target, "wx", 0o600);
      for (;;) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
        total += part.value.byteLength; if (total > 8 * 1024 * 1024) throw new Error("测速结果图片过大"); await writeAll(handle, part.value); }
    } finally {
      try { await reader.cancel().catch(() => undefined); }
      finally { try { reader.releaseLock(); } finally { await handle?.close(); } }
    }
    if (!total) throw new Error("测速结果图片为空");
  }, {timeoutMs: 20_000, redirects: {allowedHosts: ["www.speedtest.net"], maxRedirects: 0}});
}

async function deliver(ctx: PluginContext, invocation: CommandInvocation, result: SpeedResult, label: string): Promise<void> {
  const text = report(result, label);
  if (result.resultUrl) {
    try {
      await ctx.files.withTemp(async (directory, signal) => {
        const image = path.join(directory, "speedtest.png"); await downloadImage(ctx, result.resultUrl!, image); signal.throwIfAborted();
        const raw = invocation.message.raw as any; if (!raw?.peerId) throw new Error("消息上下文不可用");
        await ctx.telegram.withClient(client => client.sendFile(raw.peerId, {file: image, caption: text, parseMode: "html",
          replyTo: invocation.message.replyToId ?? invocation.message.id}));
      });
      await ctx.telegram.edit(invocation.message, `✅ ${label} 测速完成`); return;
    } catch { if (ctx.signal.aborted) return; ctx.log.error("speedlink_image_failed"); }
  }
  await ctx.telegram.edit(invocation.message, text, {parseMode: "html", linkPreview: false});
}

async function legacyNotice(ctx: PluginContext): Promise<string> {
  const current = await state(ctx);
  if (!current.legacyDatabaseDetected || current.legacyNoticeShown) return "";
  await update(ctx, value => ({...value, legacyNoticeShown: true}));
  return "\n\n⚠️ 检测到 Legacy servers.db；V2 不迁移密码或任意私钥路径，请用 add 重新登记 SSH agent 服务器与主机指纹。";
}

async function readBackup(ctx: PluginContext, invocation: CommandInvocation): Promise<State> {
  if (!invocation.message.saved) throw new Error("恢复只允许在收藏夹执行");
  if (invocation.message.replyToId === undefined) throw new Error("请回复 SpeedLink JSON 备份");
  const reply = await ctx.telegram.getReply(invocation.message); const raw = reply?.raw as any;
  const document = raw?.document ?? raw?.media?.document;
  if (!reply || !document) throw new Error("请回复 SpeedLink JSON 备份");
  const size = document.size === undefined ? 0 : Number(document.size);
  if (size > 256 * 1024) throw new Error("备份文件过大");
  return ctx.files.withTemp(async (directory, signal) => {
    const target = path.join(directory, "backup.json");
    await ctx.telegram.withClient(client => client.downloadMedia(raw, {outputFile: target, signal} as any));
    const info = await stat(target); if (!info.isFile() || !info.size || info.size > 256 * 1024) throw new Error("备份文件无效");
    let decoded: any; try { decoded = JSON.parse(await readFile(target, "utf8")); } catch { throw new Error("备份不是有效 JSON"); }
    const restored = normalizeState(decoded); const count = Array.isArray(decoded?.servers) ? decoded.servers.length : -1;
    if (count < 0 || count !== restored.servers.length) throw new Error("备份包含无效或重复服务器");
    return {...restored, legacyDatabaseDetected: false, legacyNoticeShown: true};
  });
}

export default function createSpeedlink() {
  const guarded = (operation: CommandDefinition["handle"]): CommandDefinition["handle"] => async (invocation, ctx) => {
    try { await operation(invocation, ctx); }
    catch (error) {
      if (!ctx.signal.aborted) { ctx.log.error("speedlink_command_failed");
        await ctx.telegram.edit(invocation.message, `SpeedLink 操作失败：${escape(error instanceof Error ? error.message : error)}`); }
    }
  };

  const run = async (invocation: CommandInvocation, ctx: PluginContext, server?: Server) => {
    const current = await state(ctx); const label = server?.name ?? "本机";
    await ctx.telegram.edit(invocation.message, `正在测试 ${label}，最长 ${current.timeoutSeconds} 秒…`);
    const result = server ? await runRemote(ctx, server, current.timeoutSeconds) : await runLocal(ctx, current.timeoutSeconds);
    await deliver(ctx, invocation, result, label);
  };

  const all: SubcommandDefinition = {description: "顺序测试全部远端服务器，可排除序号或别名", args: "[no 序号|别名...]", examples: [{args: "all"}, {args: "all no 2 backup"}],
    handle: guarded(async (invocation, ctx) => {
      const current = await state(ctx); if (!current.servers.length) { await ctx.telegram.edit(invocation.message, "尚未配置远端服务器"); return; }
      const excluded = invocation.args[0]?.toLowerCase() === "no" ? new Set(invocation.args.slice(1).map(value => selectServer(current.servers, value)?.name).filter(Boolean)) : new Set<string>();
      if (invocation.args.length && invocation.args[0]?.toLowerCase() !== "no") { await ctx.telegram.edit(invocation.message, "排除语法：all no 2 别名"); return; }
      const targets = current.servers.filter(server => !excluded.has(server.name)); const lines: string[] = [];
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new DOMException("SpeedLink all exceeded 30 minutes", "TimeoutError")), ALL_TIMEOUT_MS);
      const signal = AbortSignal.any([ctx.signal, deadline.signal]);
      let timedOut = false;
      try {
        for (const server of targets) {
          if (signal.aborted) { timedOut = deadline.signal.aborted; break; }
          await ctx.telegram.edit(invocation.message, `正在测试 ${server.name}…`);
          try { lines.push(report(await runRemote(ctx, server, current.timeoutSeconds, signal), server.name)); }
          catch {
            if (ctx.signal.aborted) return;
            if (deadline.signal.aborted) { timedOut = true; break; }
            lines.push(`<b>${escape(server.name)}</b>：失败`);
          }
        }
      } finally { clearTimeout(timer); }
      if (timedOut) lines.push("<b>批量测速已达到 30 分钟总时限，剩余服务器未执行。</b>");
      await deliverPages(ctx, invocation, lines.join("\n\n") || "没有需要测试的服务器");
    })};

  const command: CommandDefinition = {description: "使用官方 Ookla CLI 测试本机或 SSH 远端速度", args: "[序号|别名]", helpArgs: ["help", "h"],
    examples: [{args: "", description: "本机测速"}, {args: "1"}, {args: "东京"}],
    subcommands: {
      add: {description: "添加仅使用 SSH agent 的远端服务器并固定主机指纹", args: "别名 user@host:port SHA256:指纹", examples: [{args: "add 东京 ubuntu@203.0.113.2:22 SHA256:AbCdEf0123456789+/AbCdEf0123456789abc="}],
        handle: guarded(async (invocation, ctx) => {
          const [name, connection, fingerprint] = invocation.args;
          if (!name || !connection || !fingerprint || invocation.args.length !== 3) throw new Error("请提供别名、连接地址和 SHA256 主机指纹");
          const parsed = parseConnection(connection); const server = normalizeServer({name, ...parsed, fingerprint});
          if (!server) throw new Error("服务器配置无效");
          await update(ctx, value => {
            if (value.servers.some(item => item.name.toLowerCase() === server.name.toLowerCase())) throw new Error("服务器别名已存在");
            return {...value, servers: [...value.servers, server]};
          });
          await ctx.telegram.edit(invocation.message, `已添加 ${server.name}；首次测速会校验主机指纹`);
        })},
      list: {description: "列出服务器、端口与指纹（不保存密码或私钥路径）", args: "", handle: guarded(async (invocation, ctx) => {
        const current = await state(ctx); const lines = current.servers.map((server, index) =>
          `${index + 1}. <b>${escape(server.name)}</b> · <code>${escape(server.username)}@${escape(server.host)}:${server.port}</code> · <code>${escape(server.fingerprint)}</code>`);
        await deliverPages(ctx, invocation, `${lines.join("\n") || "尚未配置服务器"}${escape(await legacyNotice(ctx))}`);
      })},
      del: {description: "按显示序号或别名删除服务器", aliases: ["delete", "rm"], args: "序号|别名", handle: guarded(async (invocation, ctx) => {
        const selector = invocation.args[0] ?? ""; if (!selector || invocation.args.length !== 1) throw new Error("请提供序号或别名");
        const current = await state(ctx); const selected = selectServer(current.servers, selector); if (!selected) throw new Error("未找到服务器");
        await update(ctx, value => ({...value, servers: value.servers.filter(server => server.name.toLowerCase() !== selected.name.toLowerCase())}));
        await ctx.telegram.edit(invocation.message, `已删除 ${selected.name}`);
      })},
      rename: {description: "修改服务器别名", args: "序号|旧别名 新别名", handle: guarded(async (invocation, ctx) => {
        const [selector, name] = invocation.args; if (!selector || !name || invocation.args.length !== 2 || name.length > 64 || /[\u0000-\u001f\u007f|]/u.test(name)) {
          throw new Error("请提供有效的序号/旧别名和新别名");
        }
        const current = await state(ctx); const selected = selectServer(current.servers, selector); if (!selected) throw new Error("未找到服务器");
        if (current.servers.some(server => server !== selected && server.name.toLowerCase() === name.toLowerCase())) throw new Error("新别名已存在");
        await update(ctx, value => ({...value, servers: value.servers.map(server => server.name.toLowerCase() === selected.name.toLowerCase() ? {...server, name} : server)}));
        await ctx.telegram.edit(invocation.message, `已重命名为 ${name}`);
      })},
      all,
      timeout: {description: `查看或设置 ${MIN_TIMEOUT_SECONDS}–${MAX_TIMEOUT_SECONDS} 秒的持久超时`, args: "[秒]", handle: guarded(async (invocation, ctx) => {
        if (!invocation.args.length) { await ctx.telegram.edit(invocation.message, `当前超时：${(await state(ctx)).timeoutSeconds} 秒`); return; }
        const seconds = parseTimeout(invocation.args[0]); if (seconds === undefined || invocation.args.length !== 1) {
          await ctx.telegram.edit(invocation.message, `超时必须是 ${MIN_TIMEOUT_SECONDS} 到 ${MAX_TIMEOUT_SECONDS} 之间的整数秒`); return;
        }
        await update(ctx, value => ({...value, timeoutSeconds: seconds})); await ctx.telegram.edit(invocation.message, `超时已设置为 ${seconds} 秒`);
      })},
      check: {description: "检查本机 speedtest 与 OpenSSH 工具", args: "", handle: guarded(async (invocation, ctx) => {
        const value = await dependencies(ctx); await ctx.telegram.edit(invocation.message,
          `本机 speedtest：${value.local ? "可用" : "缺失"}\nssh：${value.ssh ? "可用" : "缺失"}\nssh-keyscan：${value.keyscan ? "可用" : "缺失"}\nssh-keygen：${value.keygen ? "可用" : "缺失"}`);
      })},
      backup: {description: "把无密码、无私钥路径的 JSON 备份发送到收藏夹", args: "", handle: guarded(async (invocation, ctx) => {
        const current = await state(ctx); const payload = Buffer.from(JSON.stringify({schemaVersion: 1, timeoutSeconds: current.timeoutSeconds, servers: current.servers}, null, 2));
        await ctx.files.withTemp(async (directory, signal) => {
          const target = path.join(directory, "speedlink-backup.json"); await writeFile(target, payload, {mode: 0o600, flag: "wx"}); signal.throwIfAborted();
          await ctx.telegram.withClient(async client => { const {Api} = await import("teleproto");
            await client.sendFile(new Api.InputPeerSelf(), {file: target, forceDocument: true,
              attributes: [new Api.DocumentAttributeFilename({fileName: "speedlink-backup.json"})], caption: "SpeedLink V2 脱敏备份"}); });
        });
        await ctx.telegram.edit(invocation.message, "备份已发送到收藏夹");
      })},
      restore: {description: "从回复的脱敏 JSON 恢复服务器配置（仅收藏夹）", subcommands: {
        confirm: {description: "确认覆盖现有服务器与超时设置", args: "", handle: guarded(async (invocation, ctx) => {
          const restored = await readBackup(ctx, invocation); await store(ctx).update(() => restored, ctx.signal);
          await ctx.telegram.edit(invocation.message, `已恢复 ${restored.servers.length} 台服务器`);
        })}}, async handle(invocation, ctx) { await ctx.telegram.edit(invocation.message, `请回复备份并使用 ${invocation.prefix}speedlink restore confirm`); }},
    },
    help: [{heading: "远端认证：", body: "V2 只使用 SSH agent/系统 SSH 配置，不接收或保存密码，也不接受任意私钥路径。add 必须提供 SHA256 主机指纹；每次测速先用 ssh-keyscan 获取主机键并用 ssh-keygen 校验，然后启用 StrictHostKeyChecking。"},
      {heading: "资源与输出：", body: "本机和远端均执行固定的官方 speedtest JSON 参数。单台超时可设 10–180 秒，all 最长运行 30 分钟；进程、临时 known_hosts、图片下载和发送服从插件生命周期。长列表和批量结果自动分页。结果图只从 www.speedtest.net 下载，失败时回退文字。"},
      {heading: "迁移与备份：", body: "Legacy 密码和任意私钥路径不会迁移。备份只含服务器地址、用户名、端口、主机指纹和超时；restore confirm 仅允许在收藏夹覆盖。"},
      {heading: "命令别名：", body: "<code>{prefix}sl</code> 与 <code>{prefix}speedlink</code> 使用同一套参数。"}],
    handle: guarded(async (invocation, ctx) => {
      if (!invocation.args.length) { await run(invocation, ctx); return; }
      if (invocation.args.length !== 1) { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
      const selected = selectServer((await state(ctx)).servers, invocation.args[0]!); if (!selected) throw new Error("未找到服务器"); await run(invocation, ctx, selected);
    })};
  const help = (prefix: string) => renderCommandHelp("speedlink", command, {prefix, title: "🌐 SpeedLink 远端测速"});
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "speedlink", description: "使用固定 SSH 与 Ookla CLI 测试本机和远端速度",
    renderHelp: help, resources: {processes: {concurrency: 2, queueCapacity: 8, timeoutMs: 180_000, maxOutputBytes: 2 * 1024 * 1024}},
    commands: {speedlink: command, sl: command},
    async setup(ctx) {
      const legacy = await ctx.tasks.run("speedlink:legacy-probe", async signal => {
        signal.throwIfAborted(); try { await access(ctx.files.dataPath("servers.db")); return true; } catch { return false; }
      });
      await store(ctx).update(value => ({...normalizeState(value), legacyDatabaseDetected: normalizeState(value).legacyDatabaseDetected || legacy}), ctx.signal);
    },
    settings: ctx => ({id: "speedlink", title: "SpeedLink", description: "远端测速超时配置", category: "插件配置", icon: "🌐",
      getSchema: () => [{key: "timeoutSeconds", label: "超时（秒）", type: "number", min: MIN_TIMEOUT_SECONDS, max: MAX_TIMEOUT_SECONDS}],
      async getValues() { return {timeoutSeconds: (await state(ctx)).timeoutSeconds}; },
      async setValues(patch) { const timeoutSeconds = parseTimeout(patch.timeoutSeconds); if (timeoutSeconds === undefined) throw new Error("timeout must be 10-180 integer seconds");
        await update(ctx, value => ({...value, timeoutSeconds})); }}),
  });
}
