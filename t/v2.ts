import {renderHelp as renderPluginHelp} from "./v2/help";
import {lstat, open, type FileHandle} from "node:fs/promises";
import path from "node:path";
import {definePlugin, requireSdkFeatures, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

const FFMPEG = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"] as const;
const FISH_HOST = "api.fish.audio";
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
requireSdkFeatures("httpAddressPolicy");
const ROLES: Record<string, string> = {
  "薯薯":"cc1c9874effe4526883662166456513c","麦当劳":"4066d617322e41abb30ed70eaeaf273f","影视飓风":"91648d8a8d9841c5a1c54fb18e54ab04",
  "丁真":"54a5170264694bfc8e9ad98df7bd89c3","雷军":"aebaa2305aa2452fbdc8f41eec852a79","蔡徐坤":"e4642e5edccd4d9ab61a69e82d4f8a14",
  "邓紫棋":"3b55b3d84d2f453a98d8ca9bb24182d6","周杰伦":"1512d05841734931bf905d0520c272b1","周星驰":"faa3273e5013411199abc13d8f3d6445",
  "孙笑川":"e80ea225770f42f79d50aa98be3cedfc","央视配音":"59cb5986671546eaa6ca8ae6f29f6d22","阿诺":"daeda14f742f47b8ac243ccf21c62df8",
  "卢本伟":"24d524b57c5948f598e9b74c4dacc7ab","电棍":"25d496c425d14109ba4958b6e47ea037","炫狗":"b48533d37bed4ef4b9ad5b11d8b0b694",
  "阿梓":"c2a6125240f343498e26a9cf38db87b7","七海":"a7725771e0974eb5a9b044ba357f6e13","嘉然":"1d11381f42b54487b895486f69fb14fb",
  "东雪莲":"7af4d620be1c4c6686132f21940d51c5","永雏塔菲":"e1cfccf59a1c4492b5f51c7c62a8abd2","可莉":"626bb6d3f3364c9cbc3aa6a67300a664",
  "刻晴":"5611bf78886a4a9998f56538c4ec7d8c","烧姐姐":"60d377ebaae44829ad4425033b94fdea","AD学姐":"7f92f8afb8ec43bf81429cc1c9199cb1",
  "御姐":"f44181a3d6d444beae284ad585a1af37","台湾女":"e855dc04a51f48549b484e41c4d4d4cc","御女茉莉":"6ce7ea8ada884bf3889fa7c7fb206691",
  "真实女声":"c189c7cff21c400ba67592406202a3a0","女大学生":"5c353fdb312f4888836a9a5680099ef0","温情女学生":"a1417155aa234890aab4a18686d12849",
  "蒋介石":"918a8277663d476b95e2c4867da0f6a6","李云龙":"2e576989a8f94e888bf218de90f8c19a","姜文":"ee58439a2e354525bd8fa79380418f4d",
  "黑手":"f7561ff309bd4040a59f1e600f4f4338","马保国":"794ed17659b243f69cfe6838b03fd31a","罗永浩":"9cc8e9b9d9ed471a82144300b608bf7f",
  "祁同伟":"4729cb883a58431996b998f2fca7f38b","郭继承":"ecf03a0cf954498ca0005c472ce7b141","麦克阿瑟":"405736979e244634914add64e37290b0",
  "营销号":"9d2a825024ce4156a16ba3ff799c4554","蜡笔小新":"60b9a847ba6e485fa8abbde1b9470bc4","奶龙":"3d1cb00d75184099992ddbaf0fdd7387",
  "懒羊羊":"131c6b3a889543139680d8b3aa26b98d","剑魔":"ffb55be33cbb4af19b07e9a0ef64dab1","小明剑魔":"a9372068ed0740b48326cf9a74d7496a",
  "唐僧":"0fb04af381e845e49450762bc941508c","孙悟空":"8d96d5525334476aa67677fb43059dc5","王琨":"4f201abba2574feeae11e5ebf737859e",
  "麦辣鸡腿堡":"c293697468924f3089cd9b90520dbc16","猪八戒":"4313e3ec56f14eb3946630dbdad01059","夏(中配) 蔚蓝档案":"c5fca4f670214e3cb7fbb9d595552e6e",
  "蔚蓝档案阿洛娜":"6ec8168d8392467c82358a780b35c5ca","蔚蓝档案星野":"057265ac020c41a9a91d57c747d3b4c0",
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

export async function writeAll(file: Pick<FileHandle, "write">, chunk: Uint8Array, signal: AbortSignal): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    signal.throwIfAborted();
    const result = await file.write(chunk, offset, chunk.byteLength - offset);
    signal.throwIfAborted();
    if (result.bytesWritten <= 0) throw new Error("File write failed");
    offset += result.bytesWritten;
  }
}

export async function stream(response: Response, target: string, signal: AbortSignal, maximum = 50 * 1024 * 1024): Promise<void> {
  if (!response.ok || !response.body) throw new Error("Download failed");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("Response too large");
  const reader = response.body.getReader(); let handle: FileHandle | undefined, total = 0, done = false;
  let cancelling: Promise<void> | undefined;
  const cancel = () => cancelling ??= reader.cancel().catch(() => undefined);
  const onAbort = () => { void cancel(); };
  signal.addEventListener("abort", onAbort, {once: true});
  try {
    signal.throwIfAborted(); handle = await open(target, "wx", 0o600); signal.throwIfAborted();
    while (true) { signal.throwIfAborted(); const item = await reader.read(); signal.throwIfAborted();
      if (item.done) { done = true; break; }
      total += item.value.byteLength; if (total > maximum) throw new Error("Response too large");
      await writeAll(handle, item.value, signal);
    }
    if (!total) throw new Error("Empty response");
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { if (!done) await cancel(); } finally { try { reader.releaseLock(); } finally { if (handle) await handle.close(); } }
  }
}

async function ffmpeg(context: PluginContext, directory: string, signal: AbortSignal, args: readonly string[]): Promise<void> {
  for (const command of FFMPEG) {
    try { signal.throwIfAborted(); await context.processes.run(command, args, {cwd: directory, env: {}, signal,
      timeoutMs: 180_000, maxOutputBytes: 256 * 1024}); signal.throwIfAborted(); return; }
    catch (error) {
      signal.throwIfAborted();
      if ((error as {code?: unknown})?.code !== "SPAWN_FAILED") throw error;
      continue;
    }
  }
  throw new Error("FFmpeg unavailable");
}

async function synthesize(context: PluginContext, config: Profile, text: string, target: string, callerSignal: AbortSignal): Promise<void> {
  await context.http.withResponse(`https://${FISH_HOST}/v1/tts`, {method: "POST", credentials: "omit",
    headers: {authorization: `Bearer ${config.apiKey}`, "content-type": "application/json"},
    body: JSON.stringify({text, reference_id: config.defaultRoleId}), signal: callerSignal},
  (response, signal) => stream(response, target, AbortSignal.any([callerSignal, signal])),
  {timeoutMs: 60_000, redirects: {allowedHosts: [FISH_HOST], maxRedirects: 0}});
}

async function downloadCover(context: PluginContext, url: string, target: string, callerSignal: AbortSignal): Promise<boolean> {
  try { const parsed = new URL(url); if (parsed.protocol !== "https:") return false;
    await context.http.withResponse(parsed, {credentials: "omit", signal: callerSignal}, (response, signal) =>
      stream(response, target, AbortSignal.any([callerSignal, signal]), 5 * 1024 * 1024),
      {timeoutMs: 20_000, denyPrivateAddresses: true, redirects: {allowedHosts: [parsed.hostname], maxRedirects: 2}}); return true; }
  catch { callerSignal.throwIfAborted(); return false; }
}

async function send(context: PluginContext, invocation: any, file: string, options: Record<string, unknown>, callerSignal: AbortSignal,
  delivered: () => void): Promise<void> {
  const raw = invocation.message.raw as ApiTypes.Message | undefined;
  if (!raw?.peerId) throw new Error("Missing peer");
  await context.telegram.withClient(async (client, clientSignal) => { const signal = AbortSignal.any([callerSignal, clientSignal]);
    signal.throwIfAborted(); await client.sendFile(raw.peerId, {file, ...options}); delivered(); signal.throwIfAborted(); });
}

async function deleteCommand(context: PluginContext, invocation: any): Promise<void> {
  const raw = invocation.message.raw as ApiTypes.Message | undefined;
  if (typeof raw?.delete !== "function") return;
  try { context.signal.throwIfAborted();
    if ((raw as any).isPrivate === true) await raw.delete({revoke: true}); else await raw.delete();
    context.signal.throwIfAborted();
  } catch { context.signal.throwIfAborted(); context.log.error("t_command_cleanup_failed"); }
}

function userId(invocation: any): string { return String(invocation.message.senderId ?? ""); }

export default function createT() {
  const commandT = {description: "使用 Fish Audio 合成语音或音乐", async handle(invocation: any, context: PluginContext) {
    const id = userId(invocation); if (!id) return;
    const loaded = await state(context); const config = profile(loaded.value, id);
    if (!config?.apiKey) { await context.telegram.edit(invocation.message, `请先在收藏夹使用 ${invocation.prefix}tk APIKey`); return; }
    if (invocation.args[0]?.toLowerCase() === "fm" && invocation.args[1]) {
      let parsed: URL; try { parsed = new URL(invocation.args[1]); } catch { await context.telegram.edit(invocation.message, "封面必须是 HTTPS URL"); return; }
      if (parsed.protocol !== "https:") { await context.telegram.edit(invocation.message, "封面必须是 HTTPS URL"); return; }
      await loaded.store.update(value => ({...value, covers: {...value.covers, [config.defaultRole]: parsed.toString()}}));
      await context.telegram.edit(invocation.message, `已为角色 ${config.defaultRole} 设置封面`); return;
    }
    let delivered = false, cancelled = false;
    try {
      const reply = invocation.message.replyToId === undefined ? undefined : await context.telegram.getReply(invocation.message);
      context.signal.throwIfAborted();
      await context.files.withTemp(async (directory, signal) => {
        const active = AbortSignal.any([context.signal, signal]); active.throwIfAborted();
        try {
        const music = invocation.args.length >= 3;
        const title = music ? invocation.args[0] : "", artist = music ? invocation.args[1] : "";
        const album = music && invocation.args.length >= 4 ? invocation.args[2] : config.defaultRole;
        const sourceText = music ? invocation.args.slice(invocation.args.length >= 4 ? 3 : 2).join(" ") : invocation.args.join(" ") || reply?.text || "";
        const text = clean(sourceText); if (!text || text.length > 5000) throw new Error("Invalid text");
        const raw = path.join(directory, "speech.mp3"); await synthesize(context, config, text, raw, active); active.throwIfAborted();
        if (music) {
          const output = path.join(directory, "music.mp3"); const coverFile = path.join(directory, "cover.jpg");
          const cover = loaded.value.covers?.[config.defaultRole]; const hasCover = cover ? await downloadCover(context, cover, coverFile, active) : false;
          active.throwIfAborted();
          const args = ["-nostdin", "-y", "-protocol_whitelist", "file", "-i", raw];
          if (hasCover) args.push("-protocol_whitelist", "file", "-i", coverFile, "-map", "0:a", "-map", "1:v", "-c:v", "mjpeg", "-disposition:v", "attached_pic");
          args.push("-c:a", "libmp3lame", "-q:a", "2", "-id3v2_version", "3", "-metadata", `title=${title}`,
            "-metadata", `artist=${artist}`, "-metadata", `album=${album}`, "-fs", String(MAX_MEDIA_BYTES), output);
          await ffmpeg(context, directory, active, args); const info = await lstat(output); active.throwIfAborted();
          if (!info.isFile() || !info.size || info.size > MAX_MEDIA_BYTES) throw new Error("Invalid output");
          const {Api} = await import("teleproto"); active.throwIfAborted();
          await send(context, invocation, output, {caption: `${title} - ${artist}`, replyTo: reply?.id ?? invocation.message.id,
            attributes: [new Api.DocumentAttributeAudio({duration: 0, title, performer: artist})]}, active, () => { delivered = true; });
        } else {
          const output = path.join(directory, "voice.ogg");
          await ffmpeg(context, directory, active, ["-nostdin", "-y", "-protocol_whitelist", "file", "-i", raw,
            "-c:a", "libopus", "-b:a", "64k", "-vbr", "on", "-fs", String(MAX_MEDIA_BYTES), output]);
          const info = await lstat(output); active.throwIfAborted();
          if (!info.isFile() || !info.size || info.size > MAX_MEDIA_BYTES) throw new Error("Invalid output");
          const {Api} = await import("teleproto"); active.throwIfAborted();
          await send(context, invocation, output, {replyTo: reply?.id ?? invocation.message.id,
            voiceNote: true, attributes: [new Api.DocumentAttributeAudio({duration: 0, voice: true})]}, active, () => { delivered = true; });
        }
        } catch (error) { if (active.aborted) cancelled = true; throw error; }
      });
      await deleteCommand(context, invocation);
    } catch { if (context.signal.aborted || cancelled) return; if (delivered) { context.log.error("t_temp_cleanup_failed"); await deleteCommand(context, invocation); return; }
      context.log.error("t_failed");
      await context.telegram.edit(invocation.message, "语音生成失败，请确认 API Key、FFmpeg 和外部服务可用"); }
  }};
  const commandTs = {description: "查看、切换或增加语音角色", async handle(invocation: any, context: PluginContext) {
    const id = userId(invocation); if (!id) return; const loaded = await state(context); const names = Object.keys(loaded.value.roles);
    const page = invocation.args.length === 1 && /^\d+$/.test(invocation.args[0]) ? Math.max(1, Number(invocation.args[0])) : undefined;
    if (!invocation.args.length || page) { const pages = Math.max(1, Math.ceil(names.length / 20)); const selected = Math.min(page ?? 1, pages); const start = (selected - 1) * 20;
      await context.telegram.edit(invocation.message, `可用角色（${names.length}） | 第 ${selected}/${pages} 页\n当前：${profile(loaded.value, id)?.defaultRole ?? "未设置"}\n\n` +
        names.slice(start, start + 20).map((name, index) => `${start + index + 1}. ${name}`).join("\n") +
        `\n\n用法：\n• ${invocation.prefix}ts 角色名（切换）\n• ${invocation.prefix}ts 角色名 角色ID（新增/更新并切换）\n• ${invocation.prefix}ts 2（查看第 2 页）`); return; }
    const name = invocation.args[0], roleId = invocation.args[1];
    if (!roleId && !loaded.value.roles[name]) { await context.telegram.edit(invocation.message, `无效的角色名：${name}`); return; }
    await loaded.store.update(value => ({...value, roles: roleId ? {...value.roles, [name]: roleId} : value.roles,
      users: {...value.users, [id]: {...(profile(value as State, id) ?? {apiKey: ""}), defaultRole: name,
        defaultRoleId: roleId ?? value.roles[name]}}}));
    await context.telegram.edit(invocation.message, roleId ? `已新增/更新角色：${name}，并切换为默认` : `默认角色已切换为：${name}`);
  }};
  const commandTk = {description: "在收藏夹设置 Fish Audio API Key", async handle(invocation: any, context: PluginContext) {
    if (!invocation.message.saved) { await context.telegram.edit(invocation.message, "请仅在收藏夹中设置 API Key"); return; }
    const id = userId(invocation); const key = invocation.args[0] ?? ""; if (!id || !key) { await context.telegram.edit(invocation.message, "请提供 API Key"); return; }
    const loaded = await state(context); const existing = profile(loaded.value, id) ?? {apiKey: "", defaultRole: "雷军", defaultRoleId: loaded.value.roles["雷军"]};
    await loaded.store.update(value => ({...value, users: {...value.users, [id]: {...existing, apiKey: key}}}));
    await context.telegram.edit(invocation.message, "API Key 设置成功");
  }};
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "t", description: "Fish Audio 文字转语音与音乐",
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
