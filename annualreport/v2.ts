import {STRUCTURED_PLUGIN_API_VERSION, getBotName, definePlugin, renderCommandHelp, type CommandDefinition, type PluginContext} from "telebox/sdk";

type Stats = {schemaVersion: number; startTime: number; reportCount: number};
type ChatStats = {private: number; group: number; bots: number; channel: number};

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function reportYear(now = new Date()): number {
  return now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
}

function classify(dialogs: readonly any[]): ChatStats {
  const result: ChatStats = {private: 0, group: 0, bots: 0, channel: 0};
  const seen = new Set<string>();
  for (const dialog of dialogs) {
    const id = String(dialog?.id ?? dialog?.entity?.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (dialog.isUser) dialog.entity?.bot ? result.bots++ : result.private++;
    else if (dialog.isGroup) result.group++;
    else if (dialog.isChannel) result.channel++;
  }
  return result;
}

async function accountStats(context: PluginContext): Promise<{chats: ChatStats; blocked: number; user: any}> {
  return context.telegram.withClient(async client => {
    const dialogs: any[] = [];
    for (const params of [undefined, {folder: 1}]) {
      const page = await client.getDialogs(params);
      if (Array.isArray(page)) dialogs.push(...page);
    }
    const {Api} = await import("teleproto");
    const blockedResult: any = await client.invoke(new Api.contacts.GetBlocked({offset: 0, limit: 1}));
    const blocked = Number.isFinite(blockedResult?.count) ? Number(blockedResult.count) :
      Array.isArray(blockedResult?.users) ? blockedResult.users.length : 0;
    return {chats: classify(dialogs), blocked, user: await client.getMe()};
  });
}

async function hitokoto(context: PluginContext): Promise<string> {
  try {
    const data = await context.http.json<unknown>("https://v1.hitokoto.cn/?charset=utf-8", {
      method: "GET", credentials: "omit", headers: {Accept: "application/json"},
    }, {timeoutMs: 10_000, signal: context.signal,
      redirects: {allowedHosts: ["v1.hitokoto.cn"], maxRedirects: 2}}) as {hitokoto?: unknown; from_who?: unknown; from?: unknown};
    if (typeof data.hitokoto !== "string" || !data.hitokoto.trim()) throw new Error("Invalid response");
    const source = [data.from_who, data.from].filter(value => typeof value === "string" && value.trim()).join("《");
    return `“${escape(data.hitokoto.trim())}”${source ? ` — ${escape(source)}${data.from_who && data.from ? "》" : ""}` : ""}`;
  } catch {
    context.signal.throwIfAborted();
    return "“用代码表达言语的魅力，用代码书写山河的壮丽。” — 一言开发者中心";
  }
}

const annualreportCommand: CommandDefinition = {
  description: "生成 Telegram 年度使用报告",
  args: "",
  arguments: [],
  examples: [{args: "", description: "生成当前账号的年度报告"}],
  help: [
    {
      heading: "报告内容：",
      body: "显示账号会话分类、黑名单人数、Premium 状态、已激活插件数量和报告生成记录。",
    },
  ],
  async handle(invocation, context) {
    await context.telegram.edit(invocation.message, "正在生成年度报告…");
    try {
      const store = context.storage.json<Stats>("stats.json", {schemaVersion: 1, startTime: Date.now(), reportCount: 0});
      const stats = await store.update(value => ({...value, schemaVersion: 1,
        startTime: Number.isFinite(value.startTime) ? value.startTime : Date.now(),
        reportCount: (Number.isSafeInteger(value.reportCount) ? value.reportCount : 0) + 1}));
      const pluginCount = context.plugins.list().length;
      const [{chats, blocked, user}, quote] = await Promise.all([accountStats(context), hitokoto(context)]);
      const name = user?.username ? `@${user.username}` : [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "Telegram 用户";
      const days = Math.max(0, Math.floor((Date.now() - stats.startTime) / 86_400_000));
      const premium = user?.premium ? "\n⭐ <b>会员状态</b>\nTelegram Premium 已启用\n" : "";
      const clean = blocked < 20 ? "账户黑名单保持得很干净" : "愿新一年少遇到一些打扰";
      await context.telegram.edit(invocation.message, `<b>${escape(name)} 的 ${reportYear()} 年度报告</b>\n\n` +
        `📅 <b>陪伴时光</b>\n${escape(getBotName())} 已记录 ${days} 天 · 生成报告 ${stats.reportCount} 次\n已激活插件 ${pluginCount} 个\n\n` +
        `👥 <b>社交网络</b>\n频道 ${chats.channel} · 群组 ${chats.group}\n联系人 ${chats.private} · 机器人 ${chats.bots}\n\n` +
        `🛡️ <b>安全守护</b>\n黑名单 ${blocked} 人 · ${clean}\n${premium}\n` +
        `💫 <b>年度寄语</b>\n${quote}\n\n<code>#${reportYear()}年度报告</code>`, {parseMode: "html"});
    } catch {
      if (context.signal.aborted) return;
      context.log.error("annualreport_failed");
      await context.telegram.edit(invocation.message, "年度报告生成失败，请稍后重试");
    }
  },
};

export default function createAnnualReport() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "annualreport",
    description: "生成 Telegram 年度使用报告", renderHelp: prefix => renderCommandHelp("annualreport", annualreportCommand, {prefix, title: "📊 年度报告插件",
      intro: "使用 {prefix}annualreport 生成您的Telegram年度报告"}), commands: {annualreport: annualreportCommand}});
}
