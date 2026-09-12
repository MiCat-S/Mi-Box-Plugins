import {createHash, randomBytes} from "node:crypto";
import {readFile, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {
  STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp,
  type CommandDefinition, type CommandInvocation, type PluginContext, type SubcommandDefinition,
} from "telebox/sdk";
import {returnBigInt} from "teleproto/Helpers";
import {CustomFile} from "teleproto/client/uploads";
import {
  API_MIME, CLIENT_ENGINE_NOTE, FORMAT_EXT, FORMAT_LABELS,
  colorsFromThemeSettings, detectFmt, genCloudThemeSettingsExport, normalizeWallpaper,
  parseCloudSettingsJson, parseThemeBuffer, renderDoc, type ThemeDoc, type ThemeFormat,
} from "./v2/converter";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_WALLPAPER_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_WALLPAPER_CACHE_ENTRIES = 8;
const formats: readonly ThemeFormat[] = ["attheme", "tdesktop-theme", "tgx-theme", "ios-theme"];
const apiFormats: Readonly<Record<ThemeFormat, string>> = {
  attheme: "android", "tdesktop-theme": "tdesktop", "tgx-theme": "macos", "ios-theme": "ios",
};

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[character]!);

function tlName(value: any): string {
  return String(value?._ ?? value?.className ?? value?.constructor?.name ?? "").toLowerCase();
}

function randomSlug(): string {
  return `telebox_${randomBytes(9).toString("base64url").toLowerCase()}`;
}

function baseTheme(Api: any, value: unknown): any {
  const name = String(value ?? "").toLowerCase();
  if (name.includes("night")) return new Api.BaseThemeNight();
  if (name.includes("classic")) return new Api.BaseThemeClassic();
  if (name.includes("tinted") && Api.BaseThemeTinted) return new Api.BaseThemeTinted();
  return new Api.BaseThemeDay();
}

function filenameOf(raw: any): string {
  const attributes = raw?.document?.attributes ?? raw?.media?.document?.attributes ?? [];
  const item = attributes.find((value: any) => /documentattributefilename/.test(tlName(value)));
  return typeof item?.fileName === "string" ? item.fileName : "theme";
}

async function readReply(invocation: CommandInvocation, ctx: PluginContext): Promise<{buffer: Buffer; name: string}> {
  if (invocation.message.replyToId === undefined) throw new Error("请回复一个主题文件");
  const reply = await ctx.telegram.getReply(invocation.message);
  const raw = reply?.raw as any;
  const document = raw?.document ?? raw?.media?.document;
  if (!reply || !raw || !document) throw new Error("请回复一个主题文件");
  if (document.size !== undefined && BigInt(String(document.size)) > BigInt(MAX_FILE_BYTES)) throw new Error("主题文件超过 5 MiB");
  return ctx.files.withTemp(async (directory, signal) => {
    const target = path.join(directory, "input.theme");
    await ctx.telegram.withClient(async client => {
      await client.downloadMedia(raw, {outputFile: target, signal,
        progressCallback: (received: any) => {
          if (BigInt(String(received)) > BigInt(MAX_FILE_BYTES)) throw new Error("主题文件超过 5 MiB");
        }} as any);
    });
    signal.throwIfAborted();
    const info = await stat(target);
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) throw new Error("主题文件为空或超过 5 MiB");
    return {buffer: await readFile(target), name: filenameOf(raw)};
  });
}

async function sendBuffer(ctx: PluginContext, invocation: CommandInvocation, buffer: Buffer, fileName: string,
  caption: string): Promise<void> {
  await ctx.files.withTemp(async (directory, signal) => {
    const target = path.join(directory, fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120));
    await writeFile(target, buffer, {mode: 0o600, flag: "wx"});
    signal.throwIfAborted();
    await ctx.telegram.withClient(async client => {
      const {Api} = await import("teleproto");
      const raw = invocation.message.raw as any;
      if (!raw?.peerId) throw new Error("消息上下文不可用");
      await client.sendFile(raw.peerId, {file: target, forceDocument: true,
        attributes: [new Api.DocumentAttributeFilename({fileName})], caption, parseMode: "html",
        replyTo: invocation.message.replyToId ?? invocation.message.id});
    });
  });
}

async function downloadDocument(ctx: PluginContext, client: any, document: any): Promise<Buffer> {
  if (!document || document.id === undefined || document.accessHash === undefined) throw new Error("主题文档无效");
  if (document.size !== undefined && BigInt(String(document.size)) > BigInt(MAX_FILE_BYTES)) throw new Error("主题文件超过 5 MiB");
  const {Api} = await import("teleproto");
  return ctx.files.withTemp(async (directory, signal) => {
    const target = path.join(directory, "cloud.theme");
    const location = new Api.InputDocumentFileLocation({id: returnBigInt(String(document.id)),
      accessHash: returnBigInt(String(document.accessHash)), fileReference: Buffer.from(document.fileReference ?? []), thumbSize: ""});
    await client.downloadFile(location, {outputFile: target, fileSize: document.size === undefined ? undefined : returnBigInt(String(document.size)),
      dcId: document.dcId === undefined ? undefined : Number(document.dcId), signal,
      progressCallback: (received: any) => {
        if (BigInt(String(received)) > BigInt(MAX_FILE_BYTES)) throw new Error("主题文件超过 5 MiB");
      }});
    const info = await stat(target);
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) throw new Error("云端主题文件无效");
    return readFile(target);
  });
}

async function uploadWallpaper(client: any, doc: ThemeDoc): Promise<ThemeDoc> {
  if (doc.wallpaperSlug || !normalizeWallpaper(doc.wallpaper)) return doc;
  const {Api} = await import("teleproto");
  const wallpaper = normalizeWallpaper(doc.wallpaper)!;
  const png = wallpaper.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  const name = `theme-wallpaper.${png ? "png" : "jpg"}`;
  const uploaded = await client.uploadFile({file: new CustomFile(name, wallpaper.length, "", wallpaper)});
  const result: any = await client.invoke(new Api.account.UploadWallPaper({file: uploaded,
    mimeType: png ? "image/png" : "image/jpeg", settings: new Api.WallPaperSettings({blur: false, motion: false, intensity: 50})}));
  if (!result?.slug) throw new Error("壁纸上传失败");
  return {...doc, wallpaperSlug: String(result.slug)};
}

async function downloadWallpaper(ctx: PluginContext, client: any, slug: string): Promise<Buffer> {
  const {Api} = await import("teleproto");
  const result: any = await client.invoke(new Api.account.GetWallPaper({wallpaper: new Api.InputWallPaperSlug({slug})}));
  if (!result?.document) throw new Error("云壁纸不存在或没有可下载文件");
  return downloadDocument(ctx, client, result.document);
}

function inputDocument(Api: any, document: any): any {
  if (!document || document.id === undefined || document.accessHash === undefined) return undefined;
  return new Api.InputDocument({id: returnBigInt(String(document.id)), accessHash: returnBigInt(String(document.accessHash)),
    fileReference: Buffer.from(document.fileReference ?? [])});
}

async function uploadThemeDocument(client: any, buffer: Buffer, format: ThemeFormat): Promise<any> {
  const {Api} = await import("teleproto");
  const fileName = `theme${FORMAT_EXT[format]}`;
  const uploaded = await client.uploadFile({file: new CustomFile(fileName, buffer.length, "", buffer)});
  const direct = inputDocument(Api, uploaded?.document ?? uploaded);
  if (direct) return direct;
  const media: any = await client.invoke(new Api.messages.UploadMedia({peer: new Api.InputPeerSelf(),
    media: new Api.InputMediaUploadedDocument({file: uploaded, mimeType: API_MIME[format],
      attributes: [new Api.DocumentAttributeFilename({fileName})]})}));
  const converted = inputDocument(Api, media?.document);
  if (!converted) throw new Error("主题上传失败");
  return converted;
}

function parseInput(buffer: Buffer): ThemeDoc {
  if (buffer.length === 0 || buffer.length > MAX_FILE_BYTES) throw new Error("主题文件为空或超过 5 MiB");
  const doc = parseThemeBuffer(buffer, detectFmt(buffer));
  if (!doc || Object.keys(doc.colors).length === 0) throw new Error("无法识别主题格式或配色为空");
  return doc;
}

function clientList(): string {
  return `<b>支持的客户端 / 引擎</b>\n\n${Object.entries(CLIENT_ENGINE_NOTE).map(([name, note]) =>
    `• <code>${escape(name)}</code> — ${escape(note)}`).join("\n")}`;
}

export default function createTheme() {
  type ThemeBundle = {collected: Map<ThemeFormat, Buffer>; fallback?: ThemeDoc};
  type CachedWallpaper = {buffer: Buffer; hash: string};
  const inflight = new Map<string, Promise<ThemeBundle>>();
  const wallpaperBySlug = new Map<string, CachedWallpaper>();
  const slugByHash = new Map<string, string>();
  let wallpaperCacheBytes = 0;

  const wallpaperHash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
  const removeWallpaper = (slug: string) => {
    const current = wallpaperBySlug.get(slug); if (!current) return;
    wallpaperBySlug.delete(slug); wallpaperCacheBytes -= current.buffer.length;
    if (slugByHash.get(current.hash) === slug) slugByHash.delete(current.hash);
  };
  const cacheWallpaper = (slug: string, buffer: Buffer) => {
    removeWallpaper(slug);
    const hash = wallpaperHash(buffer); const previousSlug = slugByHash.get(hash);
    if (previousSlug && previousSlug !== slug) removeWallpaper(previousSlug);
    wallpaperBySlug.set(slug, {buffer, hash}); slugByHash.set(hash, slug); wallpaperCacheBytes += buffer.length;
    while (wallpaperBySlug.size > MAX_WALLPAPER_CACHE_ENTRIES || wallpaperCacheBytes > MAX_WALLPAPER_CACHE_BYTES) {
      const oldest = wallpaperBySlug.keys().next().value as string | undefined; if (!oldest) break; removeWallpaper(oldest);
    }
  };
  const cachedWallpaper = (slug: string): Buffer | undefined => {
    const current = wallpaperBySlug.get(slug); if (!current) return;
    wallpaperBySlug.delete(slug); wallpaperBySlug.set(slug, current); return current.buffer;
  };
  const resolveWallpaper = async (ctx: PluginContext, client: any, doc: ThemeDoc): Promise<ThemeDoc> => {
    if (!doc.wallpaperSlug || normalizeWallpaper(doc.wallpaper)) return doc;
    const cached = cachedWallpaper(doc.wallpaperSlug);
    const buffer = cached ?? await downloadWallpaper(ctx, client, doc.wallpaperSlug);
    if (!cached) cacheWallpaper(doc.wallpaperSlug, buffer);
    return {...doc, wallpaper: buffer};
  };
  const ensureWallpaperSlug = async (client: any, doc: ThemeDoc): Promise<ThemeDoc> => {
    const wallpaper = normalizeWallpaper(doc.wallpaper); if (doc.wallpaperSlug || !wallpaper) return doc;
    const cached = slugByHash.get(wallpaperHash(wallpaper));
    if (cached) return {...doc, wallpaperSlug: cached};
    const result = await uploadWallpaper(client, doc);
    if (result.wallpaperSlug) cacheWallpaper(result.wallpaperSlug, wallpaper);
    return result;
  };

  const fetchTheme = (ctx: PluginContext, slug: string): Promise<ThemeBundle> => ctx.telegram.withClient(async client => {
    const {Api} = await import("teleproto");
    const collected = new Map<ThemeFormat, Buffer>(); let fallback: ThemeDoc | undefined;
    for (const format of formats) {
      ctx.signal.throwIfAborted();
      try {
        const result: any = await client.invoke(new Api.account.GetTheme({format: apiFormats[format], theme: new Api.InputThemeSlug({slug})}));
        if (result?.document) {
          const buffer = await downloadDocument(ctx, client, result.document);
          collected.set(format, buffer); fallback ??= parseThemeBuffer(buffer, format) ?? undefined;
        }
        const settings = Array.isArray(result?.settings) ? result.settings[0] : result?.settings;
        if (!fallback && settings) {
          const colors = colorsFromThemeSettings(settings);
          if (Object.keys(colors).length) fallback = {format: "attheme", colors,
            basedOn: String(settings.baseTheme?._ ?? settings.baseTheme ?? "day")};
        }
      } catch { ctx.signal.throwIfAborted(); }
    }
    if (!fallback && collected.size === 0) throw new Error("云端主题不存在或没有可用格式");
    if (fallback?.wallpaperSlug && (!collected.has("attheme") || !collected.has("tdesktop-theme"))) {
      fallback = await resolveWallpaper(ctx, client, fallback);
    }
    return {collected, fallback};
  });

  const convertTo = (target: ThemeFormat): SubcommandDefinition["handle"] => async (invocation, ctx) => {
    try {
      await ctx.telegram.edit(invocation.message, `正在转换为 ${FORMAT_LABELS[target]}…`);
      const input = await readReply(invocation, ctx);
      let doc = parseInput(input.buffer);
      if (doc.wallpaperSlug && !normalizeWallpaper(doc.wallpaper) && (target === "attheme" || target === "tdesktop-theme")) {
        doc = await ctx.telegram.withClient(client => resolveWallpaper(ctx, client, doc));
      }
      if ((target === "ios-theme" || target === "tgx-theme") && normalizeWallpaper(doc.wallpaper) && !doc.wallpaperSlug) {
        doc = await ctx.telegram.withClient(client => ensureWallpaperSlug(client, doc));
      }
      const output = renderDoc(doc, target, path.basename(input.name).replace(/\.[^.]+$/u, "") || "TeleBox Theme");
      if (!output) throw new Error("主题转换失败");
      await sendBuffer(ctx, invocation, output, `theme${FORMAT_EXT[target]}`,
        `✅ 已转换为 <b>${escape(FORMAT_LABELS[target])}</b> · ${Object.keys(doc.colors).length} 色`);
      await ctx.telegram.edit(invocation.message, `✅ 已完成 ${FORMAT_LABELS[target]} 转换`);
    } catch (error) {
      if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `主题转换失败：${escape(error instanceof Error ? error.message : error)}`);
    }
  };

  const link: SubcommandDefinition = {description: "下载 t.me/addtheme 主题并补齐四端格式", args: "链接",
    examples: [{args: "link https://t.me/addtheme/example"}], async handle(invocation, ctx) {
      const value = invocation.args[0] ?? "";
      const matched = /^(?:https?:\/\/)?t\.me\/addtheme\/([A-Za-z0-9_.-]{1,64})\/?$/u.exec(value);
      if (!matched) { await ctx.telegram.edit(invocation.message, "链接格式应为 https://t.me/addtheme/slug"); return; }
      const slug = matched[1]!; const key = slug.toLowerCase();
      let running = inflight.get(key);
      if (running) await ctx.telegram.edit(invocation.message, `正在复用 ${escape(slug)} 的主题数据…`);
      else {
        await ctx.telegram.edit(invocation.message, `正在读取云端主题 ${escape(slug)}…`);
        const created = fetchTheme(ctx, slug);
        running = created.finally(() => { if (inflight.get(key) === running) inflight.delete(key); });
        inflight.set(key, running);
      }
      try {
        const {collected, fallback} = await running;
        for (const format of formats) {
          const buffer = collected.get(format) ?? (fallback ? renderDoc(fallback, format, slug) : null);
          if (!buffer) continue;
          await sendBuffer(ctx, invocation, buffer, `${slug}${FORMAT_EXT[format]}`,
            `🎨 <b>${escape(slug)}</b> · ${escape(FORMAT_LABELS[format])}`);
        }
        await ctx.telegram.edit(invocation.message, `✅ 云端主题已处理：${escape(slug)}`, {parseMode: "html"});
      } catch (error) {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `云端主题读取失败：${escape(error instanceof Error ? error.message : error)}`);
      }
    }};

  const cloud: SubcommandDefinition = {description: "把回复的主题文件创建为 Telegram 云端主题", args: "",
    async handle(invocation, ctx) {
      try {
        const input = await readReply(invocation, ctx);
        const parsed = parseInput(input.buffer);
        const format = detectFmt(input.buffer) ?? parsed.format;
        const converted = parseCloudSettingsJson(input.buffer) ? renderDoc(parsed, "attheme") : renderDoc(parsed, format);
        if (!converted) throw new Error("主题规范化失败");
        const slug = randomSlug();
        const created: any = await ctx.telegram.withClient(async client => {
          const {Api} = await import("teleproto");
          const document = await uploadThemeDocument(client, converted, format);
          return client.invoke(new Api.account.CreateTheme({slug, title: `TeleBox Theme (${FORMAT_LABELS[format]})`, document}));
        });
        const resultSlug = String(created?.slug ?? slug);
        await ctx.telegram.edit(invocation.message, `✅ 云端主题已创建\nhttps://t.me/addtheme/${escape(resultSlug)}`, {parseMode: "html", linkPreview: false});
      } catch (error) {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `云端主题创建失败：${escape(error instanceof Error ? error.message : error)}`);
      }
    }};

  const cloudSettings: SubcommandDefinition = {description: "创建供 Unigram/Web 使用的云端配色主题", aliases: ["settings", "cloudsettings"], args: "",
    async handle(invocation, ctx) {
      try {
        const input = await readReply(invocation, ctx);
        let doc = parseInput(input.buffer);
        const result = await ctx.telegram.withClient(async client => {
          const {Api} = await import("teleproto");
          doc = await uploadWallpaper(client, doc);
          const exported = genCloudThemeSettingsExport(doc.colors, {title: "TeleBox Theme", basedOn: doc.basedOn,
            wallpaperSlug: doc.wallpaperSlug, wallpaperBlur: doc.wallpaperBlur, wallpaperMotion: doc.wallpaperMotion});
          const payload = JSON.parse(exported); const settings = payload.settings;
          const inputSettings = new Api.InputThemeSettings({baseTheme: baseTheme(Api, settings.baseTheme?._ ?? settings.baseTheme),
            accentColor: settings.accentColor, outboxAccentColor: settings.outboxAccentColor,
            messageColors: settings.messageColors ?? [],
            wallpaper: doc.wallpaperSlug ? new Api.InputWallPaperSlug({slug: doc.wallpaperSlug}) : undefined,
            wallpaperSettings: doc.wallpaperSlug ? new Api.WallPaperSettings({blur: Boolean(doc.wallpaperBlur),
              motion: doc.wallpaperMotion !== false, intensity: doc.wallpaperIntensity ?? 50}) : undefined});
          const slug = randomSlug();
          const created: any = await client.invoke(new Api.account.CreateTheme({slug, title: "TeleBox Cloud Theme", settings: [inputSettings]}));
          return {slug: String(created?.slug ?? slug), exported};
        });
        await sendBuffer(ctx, invocation, Buffer.from(result.exported), `${result.slug}-cloud-settings.json`, "☁️ 云端 themeSettings 备份");
        await ctx.telegram.edit(invocation.message, `✅ 云端配色主题已创建\nhttps://t.me/addtheme/${escape(result.slug)}`, {parseMode: "html", linkPreview: false});
      } catch (error) {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `云端配色创建失败：${escape(error instanceof Error ? error.message : error)}`);
      }
    }};

  const targetCommands: Record<string, SubcommandDefinition> = {
    android: {description: "转换为 Android .attheme", aliases: ["official", "nekogram", "neko", "nicegram", "owlgram", "extera", "cherrygram", "materialgram"], args: "", handle: convertTo("attheme")},
    desktop: {description: "转换为 Desktop .tdesktop-theme", aliases: ["tdesktop", "64gram", "kotatogram", "ayugram", "unigram", "web", "webk", "weba", "telegramweb"], args: "", handle: convertTo("tdesktop-theme")},
    tgx: {description: "转换为 Telegram X/macOS .tgx-theme", aliases: ["macos", "mac"], args: "", handle: convertTo("tgx-theme")},
    ios: {description: "转换为 iOS .tgios-theme", aliases: ["iphone"], args: "", handle: convertTo("ios-theme")},
  };
  const command: CommandDefinition = {description: "转换 Telegram 主题或创建云端主题", helpOnEmpty: true, helpArgs: ["help", "h"],
    args: "客户端", examples: [{args: "android", description: "回复主题文件转换"}, {args: "clients"}],
    subcommands: {link, cloud, "cloud-settings": cloudSettings,
      clients: {description: "列出客户端与实际主题引擎", aliases: ["list"], args: "", async handle(invocation, ctx) {
        await ctx.telegram.edit(invocation.message, clientList(), {parseMode: "html"});
      }}, ...targetCommands},
    help: [{heading: "输入与限制：", body: "仅响应显式 theme 命令，须回复不超过 5 MiB 的 .attheme、.tdesktop-theme、.tgx-theme、.tgios-theme 或 cloud-settings.json。ZIP 限制 64 项、单项 8 MiB、总展开 16 MiB、压缩比 100。"},
      {heading: "云端操作：", body: "link 仅读取 t.me/addtheme；cloud 与 cloud-settings 会在当前 Telegram 账号创建新主题。把内嵌壁纸转换为 iOS/TGX 时会创建云壁纸，并在当前插件实例的有界缓存中复用。插件不会注册广域文件监听。"}],
    async handle(invocation, ctx) { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); }};
  const help = (prefix: string) => renderCommandHelp("theme", command, {prefix, title: "🎨 Telegram 主题转换"});
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "theme", description: "转换 Telegram 四端主题与云端配色",
    renderHelp: help, commands: {theme: command}, cleanup() {
      inflight.clear(); wallpaperBySlug.clear(); slugByHash.clear(); wallpaperCacheBytes = 0;
    }});
}
