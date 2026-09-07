import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import path from "node:path";

type Channel = {title: string; handle: string; linkedGroup?: string};
type Config = {schemaVersion: 1; defaultChannel: string | null; channelList: Channel[]; adFilters: string[]};
const DEFAULT_FILTERS = ["广告","推广","赞助","合作","代理","招商","加盟","投资","理财","贷款","借钱","网贷","信用卡","pos机","刷单","兼职","副业","微商","代购","优惠券","返利","红包","博彩","赌博","股票","期货","外汇","数字货币","比特币","vpn","代理ip"];
const defaults: Config = {schemaVersion: 1, defaultChannel: null, channelList: [], adFilters: DEFAULT_FILTERS};
const database = (ctx: PluginContext) => ctx.storage.json<Config>("channel_search_config.json", defaults);
const messageText = (m: any) => String(m?.text || m?.message || "");
const normalize = (text: string) => text.toLowerCase().replace(/[-_\s.|\\/#]+/g, " ").replace(/\s+/g, " ").trim();
const fileName = (m: any): string => m?.video?.attributes?.find((a: any) => a.className === "DocumentAttributeFilename")?.fileName || "";
const duration = (m: any): number => Number(m?.video?.attributes?.find((a: any) => a.className === "DocumentAttributeVideo")?.duration || 0);
const matches = (m: any, query: string) => {
  const q = normalize(query), parts = q.split(" ").filter(Boolean);
  return [messageText(m), fileName(m)].some(source => { const text = normalize(source); return text.includes(q) || parts.every(part => text.split(" ").some(word => word.includes(part))); });
};
const isAd = (m: any, config: Config) => config.adFilters.some(word => `${messageText(m)}\n${fileName(m)}`.toLowerCase().includes(word.toLowerCase()));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

async function add(ctx: PluginContext, message: MessageEnvelope, raw: string) {
  if (!raw) throw new Error("请提供频道链接或 @username，使用 \\ 分隔。");
  const config = await database(ctx).read(); const added: Channel[] = []; const failures: string[] = [];
  await ctx.telegram.withClient(async (client: any) => {
    const {Api} = await import("teleproto");
    for (const value of raw.split("\\").map(item => item.trim()).filter(Boolean)) {
      if (config.channelList.some(item => item.handle === value) || added.some(item => item.handle === value)) { failures.push(`${value}: 已存在`); continue; }
      try {
        const entity: any = await client.getEntity(value);
        if (!entity || !["Channel", "Chat"].includes(entity.className)) { failures.push(`${value}: 不是公开频道、群组或讨论组`); continue; }
        let linkedGroup: string | undefined;
        if (entity.className === "Channel" && entity.broadcast && !entity.megagroup) {
          try { const full: any = await client.invoke(new Api.channels.GetFullChannel({channel: entity})); const id = full?.fullChat?.linkedChatId; if (id) { const linked: any = await client.getEntity(id); linkedGroup = linked?.username ? `@${linked.username}` : undefined; } } catch {}
        }
        added.push({title: entity.title || value, handle: value, linkedGroup});
      } catch (error) { failures.push(`${value}: ${errorText(error)}`); }
    }
  });
  await database(ctx).update(current => ({...current, schemaVersion: 1, channelList: [...current.channelList, ...added], defaultChannel: current.defaultChannel ?? added[0]?.handle ?? null}));
  await ctx.telegram.edit(message, `✅ 成功添加 ${added.length} 个频道。${failures.length ? `\n⚠️ ${failures.join("\n")}` : ""}`);
}

async function manage(ctx: PluginContext, message: MessageEnvelope, args: readonly string[]): Promise<boolean> {
  const sub = args[0]?.toLowerCase(), raw = args.slice(1).join(" ");
  if (sub === "add") { await add(ctx, message, raw); return true; }
  if (sub === "del") {
    if (!raw) throw new Error("用法: so del <频道链接|序号> [...] 或 so del all。");
    const before = await database(ctx).read(); const targets = new Set<string>();
    if (raw.toLowerCase() === "all") before.channelList.forEach(item => targets.add(item.handle));
    else for (const token of raw.split(/[\s\\]+/).filter(Boolean)) { const n = Number(token); targets.add(Number.isInteger(n) && n > 0 && n <= before.channelList.length ? before.channelList[n - 1].handle : token); }
    const removed = before.channelList.filter(item => targets.has(item.handle));
    await database(ctx).update(current => ({...current, channelList: current.channelList.filter(item => !targets.has(item.handle)), defaultChannel: current.defaultChannel && targets.has(current.defaultChannel) ? current.channelList.find(item => !targets.has(item.handle))?.handle ?? null : current.defaultChannel}));
    await ctx.telegram.edit(message, removed.length ? `✅ 成功移除 ${removed.length} 个频道:\n- ${removed.map(item => item.title).join("\n- ")}` : "❓ 在列表中未找到指定的频道或序号。"); return true;
  }
  if (sub === "default") {
    const config = await database(ctx).read();
    if (!raw) throw new Error("用法: so default <频道链接> 或 so default d。");
    const value = raw === "d" ? null : raw;
    if (value && !config.channelList.some(item => item.handle === value)) throw new Error("请先使用 so add 添加此频道。");
    await database(ctx).update(current => ({...current, defaultChannel: value}));
    await ctx.telegram.edit(message, value ? `✅ 已将 "${value}" 设为默认频道。` : "✅ 默认频道已移除。"); return true;
  }
  if (sub === "list") { const config = await database(ctx).read(); await ctx.telegram.edit(message, config.channelList.length ? `**当前搜索频道列表:**\n\n${config.channelList.map((item,i) => `${i+1}. ${item.title}${item.handle === config.defaultChannel ? " (默认)" : ""}`).join("\n")}` : "没有添加任何搜索频道。", {parseMode:"markdown"}); return true; }
  if (sub === "ad") {
    const action = args[1]?.toLowerCase(), words = args.slice(2);
    if (action === "list") { const config = await database(ctx).read(); await ctx.telegram.edit(message, config.adFilters.length ? `**当前广告过滤词:**\n\n${config.adFilters.join(", ")}` : "当前没有广告过滤词。", {parseMode:"markdown"}); return true; }
    if (!words.length || !["add","del"].includes(action)) throw new Error("用法: so ad <add|del|list> [关键词]");
    await database(ctx).update(current => ({...current, adFilters: action === "add" ? [...current.adFilters, ...words] : current.adFilters.filter(item => !words.includes(item))}));
    await ctx.telegram.edit(message, `✅ 成功${action === "add" ? "添加" : "删除"} ${words.length} 个广告过滤词。`); return true;
  }
  if (sub === "export") {
    const config = await database(ctx).read(); if (!config.channelList.length) { await ctx.telegram.edit(message, "没有可导出的频道。"); return true; }
    await ctx.telegram.withClient(client => client.sendFile((message.raw as any)?.chatId ?? message.chatId, {file: Buffer.from(config.channelList.map(item => item.handle).join("\n")), caption: "✅ 您的频道源已导出。", replyTo: message.id})); return true;
  }
  if (sub === "import") {
    const reply = await ctx.telegram.getReply(message); if (!reply) throw new Error("❌ 请回复备份文件。");
    const text = await ctx.telegram.withClient(async (client: any) => { const raw: any = reply.raw; const data = await client.downloadMedia(raw?.media); return Buffer.isBuffer(data) ? data.toString() : String(data ?? ""); });
    const handles = text.split(/\r?\n/).map(item => item.trim()).filter(Boolean); if (!handles.length) throw new Error("备份文件无效。"); await add(ctx, message, handles.join("\\")); return true;
  }
  return false;
}

async function search(ctx: PluginContext, message: MessageEnvelope, originalArgs: readonly string[]) {
  const spoiler = originalArgs.some(item => item.toLowerCase() === "-s"), random = originalArgs.some(item => item.toLowerCase() === "-r");
  const args = originalArgs.filter(item => !["-s","-r"].includes(item.toLowerCase()));
  const type = args[0]?.toLowerCase() === "kkp" ? "kkp" : "search", query = type === "search" ? args.join(" ") : "";
  if (type === "search" && !query) throw new Error("请输入搜索关键词。");
  const config = await database(ctx).read(); if (!config.channelList.length) throw new Error("请至少使用 so add 添加一个搜索频道。");
  await ctx.telegram.edit(message, type === "kkp" ? "🎲 正在随机寻找视频..." : "🔍 正在搜索视频...");
  await ctx.telegram.withClient(async (client: any, signal) => {
    const order = [...new Set([config.defaultChannel, ...config.channelList.map(item => item.handle)].filter(Boolean) as string[])]; const videos: any[] = [];
    for (const handle of order) {
      signal.throwIfAborted();
      try {
        const entity = await client.getEntity(handle); const found: any[] = await client.getMessages(entity, {limit: 200, ...(query ? {search: query} : {})});
        const valid = found.filter(item => item.video && !isAd(item, config) && (type === "search" ? matches(item, query) : duration(item) >= 20 && duration(item) <= 180)); videos.push(...valid);
        const info = config.channelList.find(item => item.handle === handle);
        if (type === "search" && query && info?.linkedGroup) {
          const linked = await client.getEntity(info.linkedGroup);
          const linkedFound: any[] = await client.getMessages(linked, {limit: 100, search: query});
          videos.push(...linkedFound.filter(item => item.video && matches(item, query) && !isAd(item, config)));
        }
        if (valid.length && type === "search" && !random) break;
      } catch (error) { ctx.log.error("search_source_failed", {source: handle, error: errorText(error).slice(0, 160)}); }
    }
    const unique = [...new Map(videos.map(item => [`${item.peerId ?? ""}:${item.id}`, item])).values()];
    if (!unique.length) { await ctx.telegram.edit(message, type === "kkp" ? "🤷‍♂️ 未找到合适的视频。" : "❌ 在任何频道中均未找到匹配结果。"); return; }
    const selected: any = random || type === "kkp" ? unique[Math.floor(Math.random()*unique.length)] : unique.sort((a,b) => (matches(b, query)?1:0)-(matches(a,query)?1:0) || duration(b)-duration(a))[0];
    await ctx.telegram.edit(message, "✅ 已找到结果，准备发送...");
    const peer: any = (message.raw as any)?.peerId ?? message.chatId;
    if (!spoiler) {
      try { await client.forwardMessages(peer, {messages:[selected.id], fromPeer:selected.peerId}); return; } catch {}
    }
    await ctx.files.withTemp(async (directory, scoped) => {
      const target = path.join(directory, "video.mp4"); await client.downloadMedia(selected.media, {outputFile: target}); scoped.throwIfAborted();
      await client.sendFile(peer, {file: target, caption: query || messageText(selected), spoiler, forceDocument:false, replyTo:message.id});
    });
  });
}

export default function createSearch() { return definePlugin({apiVersion:1,id:"search",description:"多频道视频资源搜索与频道源管理",settings: ctx => ({id:"search",title:"频道搜索",description:"频道搜索配置：默认频道、广告过滤",category:"插件配置",icon:"🔍",getSchema:()=>[{key:"defaultChannel",label:"默认频道",type:"string"},{key:"adFilters",label:"广告过滤词列表",type:"json"}],getValues:()=>database(ctx).read(),async setValues(patch){await database(ctx).update(current=>({...current,...patch,channelList:current.channelList,schemaVersion:1} as Config));}}),commands:{
  so:{description:"搜索视频或管理频道源",async handle({message,args},ctx){try{await ctx.telegram.edit(message,"⚙️ 正在执行命令...");if(!(await manage(ctx,message,args)))await search(ctx,message,args);}catch(error){if(!ctx.signal.aborted)await ctx.telegram.edit(message,`❌ 错误：\n${errorText(error)}`);}}},
  search:{description:"搜索视频或管理频道源",async handle({message,args},ctx){try{await ctx.telegram.edit(message,"⚙️ 正在执行命令...");if(!(await manage(ctx,message,args)))await search(ctx,message,args);}catch(error){if(!ctx.signal.aborted)await ctx.telegram.edit(message,`❌ 错误：\n${errorText(error)}`);}}},
}}); }
