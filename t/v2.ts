import {access, open, stat} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, type CommandInvocation, definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";
import {writeAll} from "./v2/io";

const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const FISH_HOST = "api.fish.audio";
const ROLES: Record<string, string> = {
  "薯薯":"cc1c9874effe4526883662166456513c","麦当劳":"4066d617322e41abb30ed70eaeaf273f","影视飓风":"91648d8a8d9841c5a1c54fb18e54ab04",
  "丁真":"54a5170264694bfc8e9ad98df7bd89c3","雷军":"aebaa2305aa2452fbdc8f41eec852a79","蔡徐坤":"e4642e5edccd4d9ab61a69e82d4f8a14",
  "邓紫棋":"3b55b3d84d2f453a98d8ca9bb24182d6","周杰伦":"1512d05841734931bf905d0520c272b1","周星驰":"faa3273e5013411199abc13d8f3d6445",
  "孙笑川":"e80ea225770f42f79d50aa98be3cedfc","央视配音":"59cb5986671546eaa6ca8ae6f29f6d22","阿诺":"daeda14f742f47b8ac243ccf21c62df8",
  "卢本伟":"24d524b57c5948f598e9b74c4dacc7ab","电棍":"25d496c425d14109ba4958b6e47ea037","炫狗":"b48533d37bed4ef4b9ad5b11d8b0b694",
  "阿梓":"c2a6125240f343498e26a9cf38db87b7","七海":"a7725771e0974eb5a9b044ba357f6e13","嘉然":"1d11381f42b54487b895486f69fb14fb",
  "东雪莲":"7af4d620be1c4c6686132f21940d51c5","永雏塔菲":"e1cfccf59a1c4492b5f51c7c62a8abd2","可莉":"626bb6d3f3364c9cbc3aa6a67300a664",
  "刻晴":"5611bf78886a4a9998f56538c4ec7d8c","真实女声":"c189c7cff21c400ba67592406202a3a0","李云龙":"2e576989a8f94e888bf218de90f8c19a",
  "姜文":"ee58439a2e354525bd8fa79380418f4d","罗永浩":"9cc8e9b9d9ed471a82144300b608bf7f","懒羊羊":"131c6b3a889543139680d8b3aa26b98d",
  "唐僧":"0fb04af381e845e49450762bc941508c","孙悟空":"8d96d5525334476aa67677fb43059dc5","猪八戒":"4313e3ec56f14eb3946630dbdad01059",
};
type Profile = {apiKey: string; defaultRole: string; defaultRoleId: string};
type State = {schemaVersion: number; users: Record<string, Profile>; roles: Record<string, string>; covers: Record<string, string>};
const INITIAL: State = {schemaVersion: 1, users: {}, roles: ROLES, covers: {"薯薯": "https://raw.githubusercontent.com/Yu9191/-/main/image.png"}};

function clean(text: string): string {
  return text.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/[^\p{Script=Han}a-zA-Z0-9\s，。？！、,?!.]/gu, "").replace(/([，。？！、,?!.])\1+/g, "$1").trim();
}
function profile(state: State, user: string): Profile | undefined { return state.users[user] ?? state.users.panel; }

async function state(context: PluginContext) {
  const store = context.storage.json<State>("tts_data.json", INITIAL);
  await store.read();
  const value = await store.update(current => ({...current, schemaVersion: 1,
    users: current.users && typeof current.users === "object" ? current.users : {},
    roles: {...ROLES, ...(current.roles && typeof current.roles === "object" ? current.roles : {})},
    covers: {"薯薯": INITIAL.covers["薯薯"], ...(current.covers && typeof current.covers === "object" ? current.covers : {})}}));
  return {store, value: value as State};
}

export async function stream(response: Response, target: string, signal: AbortSignal, maximum = 50 * 1024 * 1024): Promise<void> {
  if (!response.ok || !response.body) throw new Error("Download failed");
  const reader = response.body.getReader(); let handle: Awaited<ReturnType<typeof open>> | undefined; let total = 0, done = false;
  let cancellation: Promise<void> | undefined;
  const cancel = () => cancellation ??= reader.cancel();
  const abort = () => { void cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, {once: true});
  try {
    handle = await open(target, "wx", 0o600);
    while (true) {
      signal.throwIfAborted(); const item = await reader.read(); signal.throwIfAborted();
      if (item.done) { done = true; break; }
      total += item.value.byteLength; if (total > maximum) throw new Error("Response too large"); await writeAll(handle, item.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    try { if (!done || cancellation) await cancel(); }
    finally { try { await handle?.close(); } finally { reader.releaseLock(); } }
  }
}

async function ffmpeg(context: PluginContext, args: readonly string[]): Promise<void> {
  for (const command of FFMPEG) {
    try { await context.processes.run(command, args, {timeoutMs: 180_000, maxOutputBytes: 256 * 1024}); return; }
    catch (error) {
      context.signal.throwIfAborted();
      if ((error as {code?: unknown})?.code !== "SPAWN_FAILED") throw error;
      try { await access(command, constants.F_OK); } catch { continue; }
      throw error;
    }
  }
  throw new Error("FFmpeg unavailable");
}

async function synthesize(context: PluginContext, config: Profile, text: string, target: string): Promise<void> {
  await context.http.withResponse(`https://${FISH_HOST}/v1/tts`, {method: "POST", credentials: "omit",
    headers: {authorization: `Bearer ${config.apiKey}`, "content-type": "application/json"},
    body: JSON.stringify({text, reference_id: config.defaultRoleId})},
  (response, signal) => stream(response, target, signal),
  {timeoutMs: 60_000, redirects: {allowedHosts: [FISH_HOST], maxRedirects: 0}});
}

async function downloadCover(context: PluginContext, url: string, target: string): Promise<boolean> {
  try { const parsed = new URL(url); if (parsed.protocol !== "https:") return false;
    await context.http.withResponse(parsed, {credentials: "omit"}, (response, signal) => stream(response, target, signal, 5 * 1024 * 1024),
      {timeoutMs: 20_000, redirects: {allowedHosts: [parsed.hostname], maxRedirects: 2}}); return true; }
  catch { return false; }
}

async function send(context: PluginContext, invocation: any, file: string, options: Record<string, unknown>): Promise<void> {
  const raw = invocation.message.raw as ApiTypes.Message | undefined;
  if (!raw?.peerId) throw new Error("Missing peer");
  await context.telegram.withClient(async (client, signal) => { await client.sendFile(raw.peerId, {file, ...options});
    if (typeof raw.delete === "function") { try { await raw.delete({revoke: Boolean((raw as any).isPrivate)}); }
      catch { if (!signal.aborted) context.log.info("t_receipt_cleanup_failed"); } } });
}

function userId(invocation: any): string { return String(invocation.message.senderId ?? ""); }

export default function createT() {
  const withProfile = (operation: (invocation: CommandInvocation, context: PluginContext, loaded: Awaited<ReturnType<typeof state>>, config: Profile) => Promise<void>): CommandDefinition["handle"] => async (invocation, context) => {
    const id = userId(invocation); if (!id) return;
    const loaded = await state(context), config = profile(loaded.value, id);
    if (!config?.apiKey) { await context.telegram.edit(invocation.message, `请先在收藏夹使用 ${invocation.prefix}tk APIKey`); return; }
    await operation(invocation, context, loaded, config);
  };
  const renderAudio = async (invocation: CommandInvocation, context: PluginContext, loaded: Awaited<ReturnType<typeof state>>, config: Profile): Promise<void> => {
    try {
      const reply = invocation.message.replyToId === undefined ? undefined : await context.telegram.getReply(invocation.message);
      await context.files.withTemp(async (directory, signal) => {
        const music = invocation.args.length >= 3;
        const title = music ? invocation.args[0] : "", artist = music ? invocation.args[1] : "";
        const album = music && invocation.args.length >= 4 ? invocation.args[2] : config.defaultRole;
        const sourceText = music ? invocation.args.slice(invocation.args.length >= 4 ? 3 : 2).join(" ") : invocation.args.join(" ") || reply?.text || "";
        const text = clean(sourceText); if (!text || text.length > 5000) throw new Error("Invalid text");
        const raw = path.join(directory, "speech.mp3"); await synthesize(context, config, text, raw); signal.throwIfAborted();
        if (music) {
          const output = path.join(directory, "music.mp3"); const coverFile = path.join(directory, "cover.jpg");
          const cover = loaded.value.covers?.[config.defaultRole]; const hasCover = cover ? await downloadCover(context, cover, coverFile) : false;
          const args = ["-nostdin", "-y", "-i", raw];
          if (hasCover) args.push("-i", coverFile, "-map", "0:a", "-map", "1:v", "-c:v", "mjpeg", "-disposition:v", "attached_pic");
          args.push("-c:a", "libmp3lame", "-q:a", "2", "-id3v2_version", "3", "-metadata", `title=${title}`,
            "-metadata", `artist=${artist}`, "-metadata", `album=${album}`, output);
          await ffmpeg(context, args); const info = await stat(output); if (!info.size) throw new Error("Empty output");
          const {Api} = await import("teleproto");
          await send(context, invocation, output, {caption: `${title} - ${artist}`, replyTo: reply?.id ?? invocation.message.id,
            attributes: [new Api.DocumentAttributeAudio({duration: 0, title, performer: artist})]});
        } else {
          const output = path.join(directory, "voice.ogg");
          await ffmpeg(context, ["-nostdin", "-y", "-i", raw, "-c:a", "libopus", "-b:a", "64k", "-vbr", "on", output]);
          const info = await stat(output); if (!info.size) throw new Error("Empty output");
          const {Api} = await import("teleproto");
          await send(context, invocation, output, {replyTo: reply?.id ?? invocation.message.id,
            voiceNote: true, attributes: [new Api.DocumentAttributeAudio({duration: 0, voice: true})]});
        }
      });
    } catch { if (context.signal.aborted) return; context.log.error("t_failed");
      await context.telegram.edit(invocation.message, "语音生成失败，请确认 API Key、FFmpeg 和外部服务可用"); }
    };
  const commandT: CommandDefinition = {
    description: "使用 Fish Audio 合成语音或音乐", args: "[文本]", subcommandsCaseSensitive: false,
    alternates: [{args: "歌曲名 歌手 [专辑名] 文本", description: "音乐模式，添加音频标题、歌手及专辑信息"}],
    examples: [{args: "你好世界"}, {args: "", description: "回复文字合成普通语音"}, {args: "示例歌曲 示例歌手 你好世界"}],
    subcommands: {fm: {description: "设置当前角色封面", args: "HTTPS链接", examples: [{args: "fm https://example.com/cover.jpg"}], handle: withProfile(async (invocation, context, loaded, config) => {
      if (!invocation.args[0]) { await renderAudio({...invocation, args: [invocation.message.text.trim().split(/\s+/)[1] ?? "fm"]}, context, loaded, config); return; }
      let parsed: URL; try { parsed = new URL(invocation.args[0]); } catch { await context.telegram.edit(invocation.message, "封面必须是 HTTPS URL"); return; }
      if (parsed.protocol !== "https:") { await context.telegram.edit(invocation.message, "封面必须是 HTTPS URL"); return; }
      await loaded.store.update(value => ({...value, covers: {...value.covers, [config.defaultRole]: parsed.toString()}}));
      await context.telegram.edit(invocation.message, `已为角色 ${config.defaultRole} 设置封面`);
    })}},
    help: [{heading: "角色与密钥命令：", body: "<code>{prefix}ts [页码]</code> 查看角色（每页 20 个）；<code>{prefix}ts 角色名</code> 切换角色；<code>{prefix}ts 角色名 角色ID</code> 新增/更新并切换；<code>{prefix}tk APIKey</code> 在收藏夹设置密钥。"}, {heading: "语音与音乐：", body: "普通模式发送 OGG 语音；三个及以上参数进入音乐模式：前三项为歌曲名、歌手、文本；四个及以上时第三项为专辑，其余为文本。需要 FFmpeg，清理后文本最多 5000 字符。发送成功后删除命令消息。fm 不带链接时作为普通文本合成。"},
      {heading: "开始使用：", body: "先在收藏夹用 <code>{prefix}tk APIKey</code> 设置密钥，再用 <code>{prefix}ts</code> 查看角色。Fish Audio 密钥：<a href=\"https://fish.audio/\">fish.audio</a>；更多角色：<a href=\"https://fish.audio/zh-CN/app/discovery/\">角色发现页</a>。"}],
    handle: withProfile(renderAudio),
  };
  const commandTs: CommandDefinition = {args: "[页码|角色名] [角色ID]",
    examples: [{args: ""}, {args: "2"}, {args: "雷军"}, {args: "自定义角色 ROLE_ID"}],
    help: [{body: "默认每页 20 个角色。角色名与 ID 需各为一个参数；带 ID 时新增或更新角色并切换，单个纯数字参数按页码处理。"}],
    description: "查看、切换或增加语音角色", async handle(invocation: any, context: PluginContext) {
    const id = userId(invocation); if (!id) return; const loaded = await state(context); const names = Object.keys(loaded.value.roles);
    const page = invocation.args.length === 1 && /^\d+$/.test(invocation.args[0]) ? Math.max(1, Number(invocation.args[0])) : undefined;
    if (!invocation.args.length || page) { const pages = Math.max(1, Math.ceil(names.length / 20)); const selected = Math.min(page ?? 1, pages); const start = (selected - 1) * 20;
      await context.telegram.edit(invocation.message, `可用角色（${names.length}） | 第 ${selected}/${pages} 页\n当前：${profile(loaded.value, id)?.defaultRole ?? "未设置"}\n\n` +
        names.slice(start, start + 20).map((name, index) => `${start + index + 1}. ${name}`).join("\n")); return; }
    const name = invocation.args[0], roleId = invocation.args[1];
    if (!roleId && !loaded.value.roles[name]) { await context.telegram.edit(invocation.message, `无效的角色名：${name}`); return; }
    await loaded.store.update(value => ({...value, roles: roleId ? {...value.roles, [name]: roleId} : value.roles,
      users: {...value.users, [id]: {...(profile(value as State, id) ?? {apiKey: ""}), defaultRole: name,
        defaultRoleId: roleId ?? value.roles[name]}}}));
    await context.telegram.edit(invocation.message, roleId ? `已新增/更新角色：${name}，并切换为默认` : `默认角色已切换为：${name}`);
  }};
  const commandTk: CommandDefinition = {args: "APIKey", examples: [{args: "YOUR_KEY"}], help: [{body: "仅收藏夹可设置，取第一个参数作为密钥。首次默认角色为雷军；密钥不回显。"}],
    description: "在收藏夹设置 Fish Audio API Key", async handle(invocation: any, context: PluginContext) {
    if (!invocation.message.saved) { await context.telegram.edit(invocation.message, "请仅在收藏夹中设置 API Key"); return; }
    const id = userId(invocation); const key = invocation.args[0] ?? ""; if (!id || !key) { await context.telegram.edit(invocation.message, "请提供 API Key"); return; }
    const loaded = await state(context); const existing = profile(loaded.value, id) ?? {apiKey: "", defaultRole: "雷军", defaultRoleId: loaded.value.roles["雷军"]};
    await loaded.store.update(value => ({...value, users: {...value.users, [id]: {...existing, apiKey: key}}}));
    await context.telegram.edit(invocation.message, "API Key 设置成功");
  }};
  const help = (prefix: string) => [renderCommandHelp("t", commandT, {prefix, title: "🔊 Fish Audio 文字转语音与音乐"}), renderCommandHelp("ts", commandTs, {prefix, title: "🎭 语音角色"}), renderCommandHelp("tk", commandTk, {prefix, title: "🔑 Fish Audio 配置"})].join("\n\n");
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "t", description: "Fish Audio 文字转语音与音乐",
    resources: {processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 180_000, maxOutputBytes: 256 * 1024}},
    commands: {t: commandT, ts: commandTs, tk: commandTk},
    settings: context => ({title: "TTS 语音", category: "插件配置", icon: "🔊", getSchema: () => [
      {key: "apiKey", label: "API 密钥", type: "password", secret: true}, {key: "defaultRole", label: "默认角色", type: "string"},
      {key: "defaultRoleId", label: "默认角色 ID", type: "string"}],
    async getValues() { const value = (await state(context)).value.users.panel ?? {apiKey: "", defaultRole: "雷军", defaultRoleId: ROLES["雷军"]}; return value; },
    async setValues(patch) { const loaded = await state(context); const current = loaded.value.users.panel ?? {apiKey: "", defaultRole: "雷军", defaultRoleId: ROLES["雷军"]};
      await loaded.store.update(value => ({...value, users: {...value.users, panel: {...current, ...patch}}})); }}),
  });
}
