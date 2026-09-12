import {
  STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, requireSdkFeatures,
  type CommandDefinition, type CommandInvocation, type MessageEnvelope,
  type PluginContext, type SubcommandDefinition,
} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";
import {
  DEFAULT_CONFIG, MAX_SESSIONS, MUSIC_SOURCES, PAGE_SIZE, SESSION_TTL_MS,
  clampPage, formatArtists, normalizeBitrate, normalizeConfig, normalizeSource,
  parsePositiveIndex, sessionKey, sourceLabel,
  type ApiSong, type MusicHubConfig, type SearchSession, type SourceKey, type SourceMode,
} from "./v2/catalog";
import {downloadSong, searchMusic, searchSource, songUrl} from "./v2/network";

const store = (context: PluginContext) => context.storage.json<MusicHubConfig>("config.json", DEFAULT_CONFIG);
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;"})[character]!);
const code = (value: unknown): string => `<code>${escape(value)}</code>`;
const bounded = (value: unknown, maximum: number): string => {
  const source = String(value ?? "");
  if (source.length <= maximum) return source;
  return `${source.slice(0, Math.max(0, maximum - 1))}…`;
};
const boundedHtml = (value: unknown, maximum: number): string => {
  let output = "";
  for (const character of String(value ?? "")) {
    const encoded = escape(character);
    if (output.length + encoded.length > maximum - 1) return `${output}…`;
    output += encoded;
  }
  return output;
};

requireSdkFeatures("httpAddressPolicy");

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "未知大小";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {value /= 1024; index += 1;}
  return `${value.toFixed(index && value < 10 ? 1 : 0)} ${units[index]}`;
}

function searchPage(session: SearchSession, prefix: string): string {
  const page = clampPage(session.page, session.results.length);
  const pages = Math.max(1, Math.ceil(session.results.length / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  const entries = session.results.slice(start, start + PAGE_SIZE).map((song, offset) => {
    const album = song.album ? ` / ${boundedHtml(song.album, 120)}` : "";
    return `🎧 ${code(`${start + offset + 1}.`)} <b>${boundedHtml(song.name, 240)}</b>\n    👤 ${boundedHtml(formatArtists(song.artist), 200)}${album}`;
  });
  const selected = session.requestedSource === "auto"
    ? `${sourceLabel("auto")} → ${sourceLabel(session.resolvedSource)}` : sourceLabel(session.resolvedSource);
  return [
    "🎵 <b>Music Hub 搜索结果</b>",
    `🔍 关键词：<code>${boundedHtml(session.query, 300)}</code>`,
    `📡 音源：${code(selected)}`,
    `📄 页码：${code(`${page}/${pages}`)}，共 ${code(session.results.length)} 首`,
    "", ...entries, "",
    `使用 ${code(`${prefix}mh 1`)} 下载；使用 ${code(`${prefix}mh next`)} / ${code(`${prefix}mh prev`)} 翻页。`,
  ].join("\n");
}

function sourceList(config: MusicHubConfig): string {
  return [
    "<b>Music Hub 音乐源</b>",
    `当前默认源：${code(sourceLabel(config.defaultSource))}`,
    "",
    `${code("auto")} — 优先稳定源并依次回退`,
    ...MUSIC_SOURCES.map(source => `${code(source.key)} — ${escape(source.name)} — ${source.stable ? "稳定" : "备用"}`),
  ].join("\n");
}

async function sendFile(
  context: PluginContext, message: MessageEnvelope, song: ApiSong,
  info: Awaited<ReturnType<typeof songUrl>>, config: MusicHubConfig,
): Promise<void> {
  await context.files.withTemp(async directory => {
    const downloaded = await downloadSong(context, song, info, config, directory);
    if (!downloaded.ok) throw new Error(downloaded.reason);
    await context.telegram.edit(message, `📤 正在上传 ${escape(song.name)}（${formatBytes(downloaded.size)}）`, {parseMode: "html"});
    await context.telegram.withClient(async (client, signal) => {
      const {Api} = await import("teleproto");
      const {CustomFile} = await import("teleproto/client/uploads.js");
      const raw = message.raw as ApiTypes.Message | undefined;
      const peer = raw?.peerId ?? await client.getInputEntity(message.chatId);
      signal.throwIfAborted();
      await client.sendFile(peer, {
        file: new CustomFile(downloaded.file.split(/[\\/]/).at(-1)!, downloaded.size, downloaded.file),
        caption: bounded(`${song.name} - ${formatArtists(song.artist)}\nsource: ${song.source}`, 900),
        replyTo: message.id,
        forceDocument: false,
        attributes: [new Api.DocumentAttributeAudio({duration: 0, title: bounded(song.name, 128), performer: bounded(formatArtists(song.artist), 128)})],
      });
      signal.throwIfAborted();
    });
  });
}

export default function createMusicHub() {
  const sessions = new Map<string, SearchSession>();
  const transfers = new Set<string>();

  const pruneSessions = (): void => {
    const expired = Date.now() - SESSION_TTL_MS;
    for (const [key, session] of sessions) if (session.createdAt < expired) sessions.delete(key);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  };
  const keyFor = (message: MessageEnvelope): string => sessionKey(message.chatId, message.senderId);
  const getSession = (message: MessageEnvelope): SearchSession | undefined => {
    pruneSessions();
    return sessions.get(keyFor(message));
  };
  const saveSession = (message: MessageEnvelope, session: SearchSession): void => {
    const key = keyFor(message);
    sessions.delete(key);
    sessions.set(key, session);
    pruneSessions();
  };
  const configuration = async (context: PluginContext): Promise<MusicHubConfig> => normalizeConfig(await store(context).read());
  const updateConfiguration = async (context: PluginContext, patch: Partial<MusicHubConfig>): Promise<MusicHubConfig> =>
    normalizeConfig(await store(context).update(value => normalizeConfig({...value, ...patch})));

  const fail = async (invocation: CommandInvocation, context: PluginContext, error: unknown): Promise<void> => {
    if (context.signal.aborted) return;
    context.log.error("music_hub_failed");
    await context.telegram.edit(invocation.message,
      `❌ <b>Music Hub 操作失败</b>\n${escape(error instanceof Error ? error.message.slice(0, 300) : "请稍后重试")}`,
      {parseMode: "html", linkPreview: false});
  };
  const guarded = (operation: (invocation: CommandInvocation, context: PluginContext) => Promise<void>): CommandDefinition["handle"] =>
    async (invocation, context) => {try {await operation(invocation, context);} catch (error) {await fail(invocation, context, error);}};

  const runSearch = async (invocation: CommandInvocation, context: PluginContext, mode: SourceMode, query: string): Promise<void> => {
    query = query.trim();
    if (!query) throw new Error("请提供搜索关键词");
    if (query.length > 200) throw new Error("搜索关键词最多 200 字符");
    await context.telegram.edit(invocation.message, `🔍 正在通过 ${escape(sourceLabel(mode))} 搜索…`, {parseMode: "html"});
    const session = await searchMusic(context, await configuration(context), mode, query);
    saveSession(invocation.message, session);
    await context.telegram.edit(invocation.message, searchPage(session, invocation.prefix), {parseMode: "html", linkPreview: false});
  };

  const sourceSearch = (source: SourceMode): SubcommandDefinition => {
    const aliases = source === "auto" ? ["a"] : MUSIC_SOURCES.find(item => item.key === source)?.aliases ?? [];
    return {
      description: `使用 ${sourceLabel(source)} 搜索`,
      ...(aliases.length ? {aliases} : {}),
      args: "关键词", arguments: [{name: "关键词", required: true}],
      examples: [{args: `${source} 周杰伦`}],
      handle: guarded((invocation, context) => runSearch(invocation, context, source, invocation.args.join(" "))),
    };
  };

  const showSources: SubcommandDefinition = {
    description: "查看全部音乐源", aliases: ["list"], args: "", examples: [{args: "sources"}],
    handle: guarded(async (invocation, context) => {
      await context.telegram.edit(invocation.message, sourceList(await configuration(context)), {parseMode: "html"});
    }),
  };
  const setDefault = guarded(async (invocation, context) => {
    const requested = invocation.args[0];
    if (!requested) {
      const config = await configuration(context);
      await context.telegram.edit(invocation.message, `当前默认源：${sourceLabel(config.defaultSource)}`);
      return;
    }
    const source = normalizeSource(requested);
    if (!source) throw new Error("不支持该音乐源");
    await updateConfiguration(context, {defaultSource: source});
    await context.telegram.edit(invocation.message, `默认源已设置为 ${sourceLabel(source)}`);
  });
  const defaultSource: SubcommandDefinition = {
    description: "查看或设置默认音乐源", aliases: ["set"], args: "[音乐源]", examples: [{args: "default auto"}, {args: "default netease"}], handle: setDefault,
  };
  const sourceCompatibility: SubcommandDefinition = {
    description: "查看音乐源；提供参数时设置默认源", args: "[音乐源]", examples: [{args: "source"}, {args: "source kuwo"}],
    handle: guarded(async (invocation, context) => {
      if (invocation.args.length) return setDefault(invocation, context);
      await context.telegram.edit(invocation.message, sourceList(await configuration(context)), {parseMode: "html"});
    }),
  };
  const bitrate: SubcommandDefinition = {
    description: "查看或设置默认码率", aliases: ["quality"], args: "[low|medium|high|数值]",
    examples: [{args: "br medium"}], handle: guarded(async (invocation, context) => {
      if (!invocation.args[0]) {
        await context.telegram.edit(invocation.message, `当前码率：${(await configuration(context)).br}`);
        return;
      }
      const br = normalizeBitrate(invocation.args[0]);
      if (!br) throw new Error("码率须为 low、medium、high 或 2 至 4 位数字");
      await updateConfiguration(context, {br});
      await context.telegram.edit(invocation.message, `默认码率已设置为 ${br}`);
    }),
  };
  const navigate = (delta: number): SubcommandDefinition => ({
    description: delta > 0 ? "显示下一页搜索结果" : "显示上一页搜索结果",
    aliases: [delta > 0 ? "n" : "p"], args: "", examples: [{args: delta > 0 ? "next" : "prev"}],
    handle: guarded(async (invocation, context) => {
      const session = getSession(invocation.message);
      if (!session) throw new Error("没有可翻页的搜索结果，请先搜索");
      session.page = clampPage(session.page + delta, session.results.length);
      await context.telegram.edit(invocation.message, searchPage(session, invocation.prefix), {parseMode: "html", linkPreview: false});
    }),
  });
  const page: SubcommandDefinition = {
    description: "跳转到指定结果页", args: "页码", arguments: [{name: "页码", required: true}], examples: [{args: "page 2"}],
    handle: guarded(async (invocation, context) => {
      const session = getSession(invocation.message);
      if (!session) throw new Error("没有可翻页的搜索结果，请先搜索");
      const selected = parsePositiveIndex(invocation.args[0]);
      if (!selected) throw new Error("页码必须是正整数");
      session.page = clampPage(selected, session.results.length);
      await context.telegram.edit(invocation.message, searchPage(session, invocation.prefix), {parseMode: "html", linkPreview: false});
    }),
  };
  const clear: SubcommandDefinition = {
    description: "清除当前用户在当前聊天的搜索会话", args: "", examples: [{args: "clear"}],
    async handle(invocation, context) {
      sessions.delete(keyFor(invocation.message));
      await context.telegram.edit(invocation.message, "当前 Music Hub 搜索会话已清除");
    },
  };
  const select = guarded(async (invocation, context) => {
    const index = parsePositiveIndex(invocation.args[0]);
    if (!index) throw new Error("请提供歌曲序号");
    const session = getSession(invocation.message);
    if (!session) throw new Error("没有可选择的搜索结果，请先搜索");
    const key = keyFor(invocation.message);
    if (transfers.has(key)) throw new Error("当前搜索结果正在传输，请勿重复选择");
    const song = session.results[index - 1];
    if (!song) throw new Error(`歌曲序号须在 1 至 ${session.results.length} 之间`);
    transfers.add(key);
    try {
      const config = await configuration(context);
      await context.telegram.edit(invocation.message, `🔗 正在获取 ${escape(bounded(song.name, 240))} 的播放链接…`, {parseMode: "html"});
      const info = await songUrl(context, song, config.br);
      await sendFile(context, invocation.message, song, info, config);
      if (sessions.get(key) === session) sessions.delete(key);
      await context.telegram.edit(invocation.message, "音乐已发送");
    } finally {transfers.delete(key);}
  });
  const play: SubcommandDefinition = {
    description: "下载并发送指定序号的歌曲", aliases: ["download", "get"], args: "序号",
    arguments: [{name: "序号", required: true}], examples: [{args: "play 1"}], handle: select,
  };
  const search: SubcommandDefinition = {
    description: "搜索音乐，可选首个参数指定音乐源", aliases: ["s"], args: "[音乐源] 关键词",
    examples: [{args: "search 周杰伦"}, {args: "search tencent 周杰伦"}],
    handle: guarded(async (invocation, context) => {
      const explicit = normalizeSource(invocation.args[0]);
      const config = await configuration(context);
      await runSearch(invocation, context, explicit ?? config.defaultSource,
        (explicit ? invocation.args.slice(1) : invocation.args).join(" "));
    }),
  };
  const check: SubcommandDefinition = {
    description: "检查十个音乐源的搜索与播放链接", aliases: ["health"], args: "", examples: [{args: "check"}],
    handle: guarded(async (invocation, context) => {
      await context.telegram.edit(invocation.message, "正在检查音乐源…");
      const results = new Array<string>(MUSIC_SOURCES.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < MUSIC_SOURCES.length) {
          const index = cursor++;
          const source = MUSIC_SOURCES[index]!;
          try {
            const started = Date.now();
            const songs = await searchSource(context, source.key, "test", 1);
            if (!songs[0]) throw new Error("无搜索结果");
            await songUrl(context, songs[0], "128");
            results[index] = `✅ ${code(source.key)} ${Date.now() - started}ms`;
          } catch (error) {
            context.signal.throwIfAborted();
            results[index] = `❌ ${code(source.key)} ${escape(error instanceof Error ? error.message.slice(0, 120) : "不可用")}`;
          }
        }
      };
      await Promise.all(Array.from({length: 3}, worker));
      await context.telegram.edit(invocation.message, `<b>Music Hub 音乐源检查</b>\n\n${results.join("\n")}`, {parseMode: "html"});
    }),
  };

  const sourceCommands = Object.fromEntries(MUSIC_SOURCES.map(source => [source.key, sourceSearch(source.key)])) as Record<SourceKey, SubcommandDefinition>;
  const command: CommandDefinition = {
    description: "搜索并下载多个来源的音乐", helpArgs: ["help", "h"], subcommandsCaseSensitive: false,
    args: "[音乐源|子命令] 关键词", examples: [{args: "周杰伦"}, {args: "netease 周杰伦"}, {args: "1"}],
    subcommands: {
      sources: showSources, source: sourceCompatibility, default: defaultSource, br: bitrate,
      check, next: navigate(1), prev: navigate(-1), page, clear, play, search,
      auto: sourceSearch("auto"), ...sourceCommands,
    },
    help: [
      {heading: "音乐源：", body: MUSIC_SOURCES.map(source => `${source.key}=${source.name}`).join("、")},
      {heading: "会话与传输：", body: "搜索会话按聊天与发送者隔离，30 分钟过期，每页 5 首；下载仅接受安全 HTTPS 音频，同主机重定向与上传字节受限。"},
    ],
    handle: guarded(async (invocation, context) => {
      const direct = parsePositiveIndex(invocation.args[0]);
      if (direct && invocation.args.length === 1) return select({...invocation, args: [String(direct)]}, context);
      const config = await configuration(context);
      await runSearch(invocation, context, config.defaultSource, invocation.args.join(" "));
    }),
  };
  const help = (prefix: string) => `${renderCommandHelp("mh", command, {prefix, title: "🎵 Music Hub"})}\n\n兼容入口：${code(`${prefix}music_hub`)}，参数与 mh 相同。`;

  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "music_hub",
    description: "GdStudio 多音源音乐搜索与下载",
    renderHelp: help,
    commands: {mh: command, music_hub: command},
    settings: context => ({
      id: "music_hub", title: "Music Hub 音乐", description: "默认音源、音质、结果数与上传大小", category: "插件配置", icon: "🎵",
      getSchema: () => [
        {key: "defaultSource", label: "默认音源", type: "select", options: [{value: "auto", label: "自动"}, ...MUSIC_SOURCES.map(source => ({value: source.key, label: source.name}))]},
        {key: "br", label: "默认音质", type: "select", options: [{value: "128", label: "128kbps"}, {value: "320", label: "320kbps"}, {value: "999", label: "无损/最高"}]},
        {key: "maxResults", label: "最大搜索结果数", type: "number", min: PAGE_SIZE, max: 100},
        {key: "maxUploadBytes", label: "最大上传大小（字节）", type: "number", min: 1024 * 1024, max: 2 * 1024 * 1024 * 1024},
      ],
      getValues: async () => configuration(context),
      setValues: async patch => {
        const next: Partial<MusicHubConfig> = {};
        if (patch.defaultSource !== undefined) {
          const value = normalizeSource(patch.defaultSource);
          if (!value) throw new Error("invalid source");
          next.defaultSource = value;
        }
        if (patch.br !== undefined) {
          const value = normalizeBitrate(patch.br);
          if (!value) throw new Error("invalid bitrate");
          next.br = value;
        }
        for (const [name, minimum, maximum] of [["maxResults", PAGE_SIZE, 100], ["maxUploadBytes", 1024 * 1024, 2 * 1024 * 1024 * 1024]] as const) {
          if (patch[name] === undefined) continue;
          const value = Number(patch[name]);
          if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`invalid ${name}`);
          next[name] = value;
        }
        await updateConfiguration(context, next);
      },
    }),
    async setup(context) {await store(context).update(normalizeConfig);},
    cleanup() {sessions.clear(); transfers.clear();},
  });
}
