import {
  STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp,
  type CommandDefinition, type MessageEnvelope, type PluginContext, type SubcommandDefinition,
} from "telebox/sdk";
import {DEFAULT_CONFIG, FISH_ROLES, fishVoiceLabel, normalizeConfig, providerOrder,
  type ProviderName, type SayConfig} from "./v2/config";
import {deleteSource, findFfmpeg, sendVoice} from "./v2/media";

const store = (ctx: PluginContext) => ctx.storage.json<SayConfig>("config.json", DEFAULT_CONFIG);
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[character]!);

async function readConfig(ctx: PluginContext): Promise<SayConfig> {
  return normalizeConfig(await store(ctx).read(ctx.signal));
}

async function updateConfig(ctx: PluginContext, change: (value: SayConfig) => SayConfig): Promise<SayConfig> {
  return store(ctx).update(value => normalizeConfig(change(normalizeConfig(value))), ctx.signal);
}

const guarded = (operation: CommandDefinition["handle"]): CommandDefinition["handle"] => async (invocation, ctx) => {
  try { await operation(invocation, ctx); }
  catch (error) {
    if (!ctx.signal.aborted) {
      ctx.log.error("say_command_failed");
      await ctx.telegram.edit(invocation.message, `语音操作失败：${escape(error instanceof Error ? error.message : error)}`);
    }
  }
};

function provider(value: string | undefined): ProviderName | undefined {
  return value === "mimo" || value === "volc" || value === "fish" ? value : undefined;
}

function keyCommand(target: ProviderName): SubcommandDefinition {
  return {description: `设置 ${target} API Key（仅收藏夹）`, args: "APIKey", async handle(invocation, ctx) {
    if (!invocation.message.saved) { await ctx.telegram.edit(invocation.message, "API Key 只能在收藏夹中设置"); return; }
    const key = invocation.args[0] ?? "";
    if (!key || invocation.args.length !== 1 || key.length > 4096) { await ctx.telegram.edit(invocation.message, "请提供一个有效的 API Key"); return; }
    await updateConfig(ctx, value => ({...value, providers: {...value.providers, [target]: {...value.providers[target], apiKey: key}}}));
    await ctx.telegram.edit(invocation.message, `${target} API Key 已更新（不会回显）`);
  }};
}

function voiceCommand(target: ProviderName): SubcommandDefinition {
  const handle: SubcommandDefinition["handle"] = async (invocation, ctx) => {
    const raw = invocation.args.join(" ").trim();
    if (!raw || raw.length > 128) { await ctx.telegram.edit(invocation.message, "请提供不超过 128 字符的音色或 reference_id"); return; }
    const voice = target === "fish" ? FISH_ROLES[raw] ?? raw : raw;
    await updateConfig(ctx, value => ({...value, providers: {...value.providers, [target]: {...value.providers[target], voice}}}));
    await ctx.telegram.edit(invocation.message, `${target} 音色已设置为：${target === "fish" ? fishVoiceLabel(voice) : voice}`);
  };
  return target !== "fish" ? {description: `设置 ${target} 音色`, args: "音色", handle} : {
    description: "设置 Fish 音色", args: "音色", handle,
    subcommands: {list: {description: "分页查看 Fish 内置角色", args: "[页码]", async handle(invocation, ctx) {
      const requested = Number(invocation.args[0] ?? 1); const names = Object.keys(FISH_ROLES); const total = Math.ceil(names.length / 20);
      const page = Number.isInteger(requested) ? Math.min(total, Math.max(1, requested)) : 1;
      const current = (await readConfig(ctx)).providers.fish.voice;
      const lines = names.slice((page - 1) * 20, page * 20).map((name, index) =>
        `${(page - 1) * 20 + index + 1}. ${escape(name)}${FISH_ROLES[name] === current ? " ✅" : ""}`);
      await ctx.telegram.edit(invocation.message, `<b>Fish 内置角色</b> · ${page}/${total}\n${lines.join("\n")}`, {parseMode: "html"});
    }}},
  };
}

export default function createSay() {
  const tails = new Map<string, Promise<void>>();
  const serial = async (key: string, operation: () => Promise<void>): Promise<void> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const current = previous.catch(() => undefined).then(() => gate);
    tails.set(key, current);
    await previous.catch(() => undefined);
    try { await operation(); }
    finally { release(); if (tails.get(key) === current) tails.delete(key); }
  };

  const chatSwitch = (enabled: boolean): SubcommandDefinition["handle"] => guarded(async (invocation, ctx) => {
    const chatId = invocation.message.chatId;
    await updateConfig(ctx, value => {
      const chats = {...value.chats}; if (enabled) chats[chatId] = true; else delete chats[chatId];
      return {...value, chats};
    });
    await ctx.telegram.edit(invocation.message, `本会话自动语音已${enabled ? "开启" : "关闭"}`);
  });

  const command: CommandDefinition = {
    description: "使用 MiMo、火山豆包或 Fish 合成语音", args: "[文本]", helpArgs: ["help", "h"],
    examples: [{args: "你好，世界"}, {args: "", description: "回复文字消息合成"}],
    subcommands: {
      on: {description: "开启当前会话自动语音", args: "", handle: chatSwitch(true)},
      off: {description: "关闭当前会话自动语音", args: "", handle: chatSwitch(false)},
      status: {description: "查看会话开关、提供商、音色与 FFmpeg 状态", args: "", handle: guarded(async (invocation, ctx) => {
        const value = await readConfig(ctx); const ffmpeg = await findFfmpeg(ctx); const order = providerOrder(value);
        await ctx.telegram.edit(invocation.message, `<b>Say 状态</b>\n会话：${value.chats[invocation.message.chatId] ? "开启" : "关闭"}\n` +
          `提供商：<code>${escape(order.join(" → ") || "未配置")}</code>\nMiMo：<code>${escape(value.providers.mimo.voice)}</code>\n` +
          `火山：<code>${escape(value.providers.volc.voice || "未设置")}</code> / <code>${escape(value.providers.volc.resourceId)}</code>\n` +
          `Fish：<code>${escape(fishVoiceLabel(value.providers.fish.voice))}</code>\nFFmpeg：${ffmpeg ? escape(ffmpeg.version || ffmpeg.path) : "不可用"}`, {parseMode: "html"});
      })},
      key: {description: "设置服务商 API Key（仅收藏夹）", subcommands: {mimo: keyCommand("mimo"), volc: keyCommand("volc"), fish: keyCommand("fish")},
        async handle(invocation, ctx) { await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}say key mimo|volc|fish APIKey`); }},
      provider: {description: "设置主服务商；失败时按固定顺序尝试其余已配置提供商", args: "mimo|volc|fish", handle: guarded(async (invocation, ctx) => {
        const selected = provider(invocation.args[0]?.toLowerCase());
        if (!selected || invocation.args.length !== 1) { await ctx.telegram.edit(invocation.message, "请选择 mimo、volc 或 fish"); return; }
        await updateConfig(ctx, value => ({...value, primary: selected})); await ctx.telegram.edit(invocation.message, `主服务商已设置为 ${selected}`);
      })},
      voice: {description: "查看或设置各服务商音色", subcommands: {mimo: voiceCommand("mimo"), volc: voiceCommand("volc"), fish: voiceCommand("fish")},
        handle: guarded(async (invocation, ctx) => { const value = await readConfig(ctx); await ctx.telegram.edit(invocation.message,
          `MiMo=${value.providers.mimo.voice} | 火山=${value.providers.volc.voice || "未设置"} | Fish=${fishVoiceLabel(value.providers.fish.voice)}`); })},
      speed: {description: "设置火山语速", args: "0.5–2.0", handle: guarded(async (invocation, ctx) => {
        const speed = Number(invocation.args[0]); if (!Number.isFinite(speed) || speed < 0.5 || speed > 2 || invocation.args.length !== 1) {
          await ctx.telegram.edit(invocation.message, "语速必须在 0.5 到 2.0 之间"); return;
        }
        await updateConfig(ctx, value => ({...value, speed})); await ctx.telegram.edit(invocation.message, `语速已设置为 ${speed}`);
      })},
      style: {description: "设置 MiMo 风格指令；clear 清除", args: "指令|clear", handle: guarded(async (invocation, ctx) => {
        const raw = invocation.args.join(" ").trim(); if (!raw || raw.length > 500) { await ctx.telegram.edit(invocation.message, "请提供不超过 500 字符的风格指令"); return; }
        const style = raw.toLowerCase() === "clear" ? "" : raw; await updateConfig(ctx, value => ({...value, style}));
        await ctx.telegram.edit(invocation.message, `MiMo 风格已${style ? "更新" : "清除"}`);
      })},
      translate: {description: "设置是否通过 ai.translate 追加译文", args: "on|off", handle: guarded(async (invocation, ctx) => {
        const enabled = invocation.args[0]?.toLowerCase(); if (enabled !== "on" && enabled !== "off") { await ctx.telegram.edit(invocation.message, "请使用 on 或 off"); return; }
        await updateConfig(ctx, value => ({...value, translate: enabled === "on"})); await ctx.telegram.edit(invocation.message, `译文已${enabled === "on" ? "开启" : "关闭"}`);
      })},
      resource: {description: "设置火山 Resource ID", args: "ID", handle: guarded(async (invocation, ctx) => {
        const resourceId = invocation.args[0] ?? ""; if (!/^[A-Za-z0-9._-]{1,80}$/u.test(resourceId) || invocation.args.length !== 1) {
          await ctx.telegram.edit(invocation.message, "Resource ID 格式无效"); return;
        }
        await updateConfig(ctx, value => ({...value, providers: {...value.providers, volc: {...value.providers.volc, resourceId}}}));
        await ctx.telegram.edit(invocation.message, `火山 Resource ID 已设置为 ${resourceId}`);
      })},
      endpoint: {description: "设置 MiMo 通用或 Token Plan 端点", args: "standard|tokenplan", handle: guarded(async (invocation, ctx) => {
        const endpoint = invocation.args[0]?.toLowerCase(); if (endpoint !== "standard" && endpoint !== "tokenplan" || invocation.args.length !== 1) {
          await ctx.telegram.edit(invocation.message, "请选择 standard 或 tokenplan"); return;
        }
        await updateConfig(ctx, value => ({...value, providers: {...value.providers, mimo: {...value.providers.mimo, endpoint}}}));
        await ctx.telegram.edit(invocation.message, `MiMo 端点已设置为 ${endpoint}`);
      })},
      ffmpeg: {description: "检查 FFmpeg；V2 不在运行时安装系统软件", subcommands: {
        install: {description: "说明受控安装要求", args: "", async handle(invocation, ctx) {
          await ctx.telegram.edit(invocation.message, "Say V2 不从 Telegram 安装 FFmpeg；请由系统管理员通过受控部署安装。");
        }}}, handle: guarded(async (invocation, ctx) => { const value = await findFfmpeg(ctx);
          await ctx.telegram.edit(invocation.message, value ? `FFmpeg 可用：${value.version || value.path}` : "FFmpeg 不可用；火山 OGG 可直接发送，MiMo/Fish 需要管理员安装 FFmpeg"); })},
    },
    help: [{heading: "自动模式：", body: "on/off 按十进制 chat ID 隔离。只处理本人发出的未编辑纯文本；命令、附件和超过 200 个 Unicode 字符的消息不会转换。成功后删除原文，失败会恢复原文。"},
      {heading: "提供商与媒体：", body: "主服务商失败后按 volc → mimo → fish 的剩余顺序回退。火山返回 OGG；MiMo WAV 和 Fish MP3 经受管 FFmpeg 转为 OGG/Opus。HTTP、进程、临时文件和上传均绑定插件生命周期。"},
      {heading: "配置与译文：", body: "API Key 仅允许在收藏夹命令或 Settings 的 secret 字段录入；secret 只控制读取不回显。译文仅通过已注册的 ai.translate 服务生成，服务不存在时保留原始 caption。"}],
    handle: guarded(async (invocation, ctx) => {
      let text = invocation.args.join(" ").trim();
      if (!text && invocation.message.replyToId !== undefined) text = (await ctx.telegram.getReply(invocation.message))?.text.trim() ?? "";
      if (!text) { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
      const value = await readConfig(ctx); if (!providerOrder(value).length) { await ctx.telegram.edit(invocation.message, "请先在收藏夹设置至少一个服务商 API Key"); return; }
      await sendVoice(ctx, invocation, text, value, progress => ctx.telegram.edit(invocation.message, progress));
      await deleteSource(invocation.message);
    }),
  };
  const help = (prefix: string) => renderCommandHelp("say", command, {prefix, title: "🗣️ Say 自动语音"});

  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "say", description: "MiMo、火山豆包与 Fish 自动语音合成",
    renderHelp: help, resources: {processes: {concurrency: 1, queueCapacity: 3, timeoutMs: 180_000, maxOutputBytes: 256 * 1024}},
    commands: {say: command}, listeners: [{direction: "outgoing", includeSaved: true, edited: false, ignoreCommands: true,
      async handle(message: MessageEnvelope, ctx: PluginContext) {
        const raw = message.raw as any;
        if (!message.text.trim() || raw?.media && tlName(raw.media) !== "messagemediawebpage" || [...message.text.trim()].length > 200) return;
        const value = await readConfig(ctx); if (!value.chats[message.chatId] || !providerOrder(value).length) return;
        await serial(message.chatId, async () => {
          const original = message.text;
          try {
            await sendVoice(ctx, {message}, original, value, progress => ctx.telegram.edit(message, progress));
            await deleteSource(message);
          } catch {
            if (!ctx.signal.aborted) { await ctx.telegram.edit(message, original); ctx.log.error("say_auto_failed"); }
          }
        });
      }}],
    async setup(ctx) { await store(ctx).update(value => normalizeConfig(value), ctx.signal); },
    cleanup() { tails.clear(); },
    settings: ctx => ({id: "say", title: "Say 语音合成", description: "MiMo / 火山豆包 / Fish 配置", category: "插件配置", icon: "🗣️",
      getSchema: () => [
        {key: "primary", label: "主服务商", type: "select", options: ["mimo", "volc", "fish"].map(value => ({value, label: value}))},
        {key: "mimoKey", label: "MiMo API Key", type: "password", secret: true},
        {key: "volcKey", label: "火山 API Key", type: "password", secret: true},
        {key: "fishKey", label: "Fish API Key", type: "password", secret: true},
        {key: "mimoEndpoint", label: "MiMo 端点", type: "select", options: [{value: "standard", label: "standard"}, {value: "tokenplan", label: "tokenplan"}]},
        {key: "mimoVoice", label: "MiMo 音色", type: "string"}, {key: "volcVoice", label: "火山音色", type: "string"},
        {key: "volcResource", label: "火山 Resource ID", type: "string"}, {key: "fishVoice", label: "Fish reference_id", type: "string"},
        {key: "speed", label: "火山语速", type: "number", min: 0.5, max: 2}, {key: "style", label: "MiMo 风格", type: "string"},
        {key: "translate", label: "追加译文", type: "boolean"},
      ],
      async getValues() { const value = await readConfig(ctx); return {primary: value.primary, mimoKey: value.providers.mimo.apiKey,
        volcKey: value.providers.volc.apiKey, fishKey: value.providers.fish.apiKey, mimoEndpoint: value.providers.mimo.endpoint,
        mimoVoice: value.providers.mimo.voice, volcVoice: value.providers.volc.voice, volcResource: value.providers.volc.resourceId,
        fishVoice: value.providers.fish.voice, speed: value.speed, style: value.style, translate: value.translate}; },
      async setValues(patch) { await updateConfig(ctx, value => normalizeConfig({...value, primary: patch.primary ?? value.primary,
        speed: patch.speed ?? value.speed, style: patch.style ?? value.style, translate: patch.translate ?? value.translate,
        providers: {mimo: {...value.providers.mimo, apiKey: typeof patch.mimoKey === "string" ? patch.mimoKey : value.providers.mimo.apiKey,
          endpoint: patch.mimoEndpoint ?? value.providers.mimo.endpoint, voice: patch.mimoVoice ?? value.providers.mimo.voice},
        volc: {...value.providers.volc, apiKey: typeof patch.volcKey === "string" ? patch.volcKey : value.providers.volc.apiKey,
          voice: patch.volcVoice ?? value.providers.volc.voice, resourceId: patch.volcResource ?? value.providers.volc.resourceId},
        fish: {...value.providers.fish, apiKey: typeof patch.fishKey === "string" ? patch.fishKey : value.providers.fish.apiKey,
          voice: patch.fishVoice ?? value.providers.fish.voice}}})); }}),
  });
}

function tlName(value: any): string {
  return String(value?._ ?? value?.className ?? value?.constructor?.name ?? "").toLowerCase();
}
