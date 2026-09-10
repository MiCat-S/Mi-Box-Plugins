import {fileName, duration, matches, score, channelVideos} from "./v2/videos";
import {setTimeout as sleep} from "node:timers/promises";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, type CommandInvocation, definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import path from "node:path";

type Channel = {title: string; handle: string; linkedGroup?: string};
type Config = {schemaVersion: 1; defaultChannel: string | null; channelList: Channel[]; adFilters: string[]};
const DEFAULT_FILTERS = ["广告","推广","赞助","合作","代理","招商","加盟","投资","理财","贷款","借钱","网贷","信用卡","pos机","刷单","兼职","副业","微商","代购","优惠券","返利","红包","博彩","赌博","股票","期货","外汇","数字货币","比特币","vpn","代理ip"];
const defaults: Config = {schemaVersion: 1, defaultChannel: null, channelList: [], adFilters: DEFAULT_FILTERS};
const database = (ctx: PluginContext) => ctx.storage.json<Config>("channel_search_config.json", defaults);
const messageText = (m: any) => String(m?.text || m?.message || "");
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
        added.push({title: entity.title || value, handle: value, ...(linkedGroup ? {linkedGroup} : {})});
      } catch (error) { failures.push(`${value}: ${errorText(error)}`); }
    }
  });
  await database(ctx).update(current => ({...current, schemaVersion: 1, channelList: [...current.channelList, ...added], defaultChannel: current.defaultChannel ?? added[0]?.handle ?? null}));
  await ctx.telegram.edit(message, `✅ 成功添加 ${added.length} 个频道。${failures.length ? `\n⚠️ ${failures.join("\n")}` : ""}`);
}

async function search(ctx: PluginContext, message: MessageEnvelope, originalArgs: readonly string[], forcedType?: "kkp") {
  const spoiler = originalArgs.some(item => item.toLowerCase() === "-s"), random = originalArgs.some(item => item.toLowerCase() === "-r");
  const args = originalArgs.filter(item => !["-s","-r"].includes(item.toLowerCase()));
  const type = forcedType ?? (args[0]?.toLowerCase() === "kkp" ? "kkp" : "search"), query = type === "search" ? args.join(" ") : "";
  if (type === "search" && !query) throw new Error("请输入搜索关键词。");
  const config = await database(ctx).read(); if (!config.channelList.length) throw new Error("请至少使用 so add 添加一个搜索频道。");
  await ctx.telegram.edit(message, type === "kkp" ? "🎲 正在随机寻找视频..." : "🔍 正在搜索视频...");
  await ctx.telegram.withClient(async (client: any, signal) => {
    const order = [...new Set([config.defaultChannel, ...config.channelList.map(item => item.handle)].filter(Boolean) as string[])]; const videos: any[] = [];
    const processedGroupIds=new Set<string>();
    for (const [index,handle] of order.entries()) {
      signal.throwIfAborted();
      if(index>0)await sleep(750,undefined,{signal});
      const info=config.channelList.find(item=>item.handle===handle);
      if(!info)continue;
      try {
        const entity=await client.getEntity(handle);
        const valid=await channelVideos(client,entity,info.linkedGroup,query,type,item=>isAd(item,config),processedGroupIds,signal);
        videos.push(...valid);
        if(valid.length&&type==="search"&&!random)break;
      } catch (error) {
        signal.throwIfAborted();
        if(errorText(error).includes("Could not find the input entity")){
          await database(ctx).update(current=>({...current,channelList:current.channelList.filter(item=>item.handle!==handle),defaultChannel:current.defaultChannel===handle?null:current.defaultChannel}));
        }
        ctx.log.error("search_source_failed", {source:handle,error:errorText(error).slice(0,160)});
      }
    }
    const unique = [...new Map(videos.map(item => [`${item.peerId ?? ""}:${item.id}`, item])).values()];
    if (!unique.length) { await ctx.telegram.edit(message, type === "kkp" ? "🤷‍♂️ 未找到合适的视频。" : "❌ 在任何频道中均未找到匹配结果。"); return; }
    const selected: any = random || type === "kkp" ? unique[Math.floor(Math.random()*unique.length)] : unique.sort((a,b) => score(b,query)-score(a,query) || duration(b)-duration(a))[0];
    await ctx.telegram.edit(message, "✅ 已找到结果，准备发送...");
    const peer: any = (message.raw as any)?.peerId ?? message.chatId;
    if (!spoiler) {
      try { await client.forwardMessages(peer, {messages:[selected.id], fromPeer:selected.peerId}); if(message.outgoing&&typeof (message.raw as any)?.delete==="function")await (message.raw as any).delete().catch(()=>{}); return; } catch {}
    }
    await ctx.files.withTemp(async (directory, scoped) => {
      const target = path.join(directory, "video.mp4"); await client.downloadMedia(selected.media, {outputFile: target}); scoped.throwIfAborted();
      const {Api}=await import("teleproto");
      const attribute=selected.video?.attributes.find((item:any)=>item.className==="DocumentAttributeVideo");
      await client.sendFile(peer, {file:target,caption:query||messageText(selected),spoiler,forceDocument:false,replyTo:message.id,
        attributes:[new Api.DocumentAttributeVideo({duration:attribute?.duration||0,w:attribute?.w||0,h:attribute?.h||0,supportsStreaming:true}),new Api.DocumentAttributeFilename({fileName:path.basename(target)})]});
    });
    if(message.outgoing&&typeof (message.raw as any)?.delete==="function")await (message.raw as any).delete().catch(()=>{});
  });
}

const guarded = (operation: CommandDefinition["handle"]): CommandDefinition["handle"] => async (i, ctx) => {
  try { await ctx.telegram.edit(i.message, "⚙️ 正在执行命令..."); await operation(i, ctx); }
  catch(error) { if (!ctx.signal.aborted) await ctx.telegram.edit(i.message, `❌ 错误：\n${errorText(error)}`); }
};
const filters = (adding: boolean): CommandDefinition["handle"] => guarded(async (i, ctx) => {
  const words = i.args;
  if (!words.length) throw new Error("用法: so ad <add|del|list> [关键词]");
  await database(ctx).update(current => ({...current, adFilters: adding ? [...current.adFilters, ...words] : current.adFilters.filter(item => !words.includes(item))}));
  await ctx.telegram.edit(i.message, `✅ 成功${adding ? "添加" : "删除"} ${words.length} 个广告过滤词。`);
});
const command: CommandDefinition = {
  description: "搜索视频或管理频道源", args: "关键词 [-s] [-r]", subcommandsCaseSensitive: false,
  arguments: [{name: "-s", description: "下载视频并作为防剧透消息发送"}, {name: "-r", description: "从匹配结果中随机选择"}],
  examples: [{args: "关键词"}, {args: "关键词 -s -r"}],
  subcommands: {
    add: {description: "添加频道、群组或讨论组", args: "频道链接或@用户名 [\\ 其他频道...]", examples: [{args: "add @channel1 \\ @channel2"}], handle: guarded((i, ctx) => add(ctx, i.message, i.args.join(" ")))},
    del: {description: "移除频道源", args: "频道链接或序号 [...]", alternates: [{args: "all", description: "移除全部频道源"}], handle: guarded(async ({message, args}, ctx) => {
      const raw = args.join(" ");

    if (!raw) throw new Error("用法: so del <频道链接|序号> [...] 或 so del all。");
    const before = await database(ctx).read(); const targets = new Set<string>();
    if (raw.toLowerCase() === "all") before.channelList.forEach(item => targets.add(item.handle));
    else for (const token of raw.split(/[\s\\]+/).filter(Boolean)) { const n = Number(token); targets.add(Number.isInteger(n) && n > 0 && n <= before.channelList.length ? before.channelList[n - 1].handle : token); }
    const removed = before.channelList.filter(item => targets.has(item.handle));
    await database(ctx).update(current => ({...current, channelList: current.channelList.filter(item => !targets.has(item.handle)), defaultChannel: current.defaultChannel && targets.has(current.defaultChannel) ? current.channelList.find(item => !targets.has(item.handle))?.handle ?? null : current.defaultChannel}));
    await ctx.telegram.edit(message, removed.length ? `✅ 成功移除 ${removed.length} 个频道:\n- ${removed.map(item => item.title).join("\n- ")}` : "❓ 在列表中未找到指定的频道或序号。"); return;

    })},
    default: {description: "设置默认频道", args: "频道链接", alternates: [{args: "d", description: "移除默认频道"}], handle: guarded(async ({message, args}, ctx) => {
      const raw = args.join(" ");

    const config = await database(ctx).read();
    if (!raw) throw new Error("用法: so default <频道链接> 或 so default d。");
    const value = raw === "d" ? null : raw;
    if (value && !config.channelList.some(item => item.handle === value)) throw new Error("请先使用 so add 添加此频道。");
    await database(ctx).update(current => ({...current, defaultChannel: value}));
    await ctx.telegram.edit(message, value ? `✅ 已将 "${value}" 设为默认频道。` : "✅ 默认频道已移除。"); return;

    })},
    list: {description: "列出频道源及默认项", args: "", handle: guarded(async ({message, args}, ctx) => {
      const raw = args.join(" ");
 const config = await database(ctx).read(); await ctx.telegram.edit(message, config.channelList.length ? `**当前搜索频道列表:**\n\n${config.channelList.map((item,i) => `${i+1}. ${item.title}${item.handle === config.defaultChannel ? " (默认)" : ""}`).join("\n")}` : "没有添加任何搜索频道。", {parseMode:"markdown"}); return;
    })},
    export: {description: "导出频道源列表文件", args: "", handle: guarded(async ({message, args}, ctx) => {
      const raw = args.join(" ");

    const config = await database(ctx).read(); if (!config.channelList.length) { await ctx.telegram.edit(message, "没有可导出的频道。"); return; }
    await ctx.telegram.withClient(client => client.sendFile((message.raw as any)?.chatId ?? message.chatId, {file: Buffer.from(config.channelList.map(item => item.handle).join("\n")), caption: "✅ 您的频道源已导出。", replyTo: message.id})); return;

    })},
    import: {description: "回复备份文件导入频道源", args: "", handle: guarded(async ({message, args}, ctx) => {
      const raw = args.join(" ");

    const reply = await ctx.telegram.getReply(message); if (!reply) throw new Error("❌ 请回复备份文件。");
    const text = await ctx.telegram.withClient(async (client: any) => { const raw: any = reply.raw; const data = await client.downloadMedia(raw?.media); return Buffer.isBuffer(data) ? data.toString() : String(data ?? ""); });
    const handles = text.split(/\r?\n/).map(item => item.trim()).filter(Boolean); if (!handles.length) throw new Error("备份文件无效。"); await add(ctx, message, handles.join("\\")); return;

    })},
    ad: {description: "管理广告过滤词", subcommands: {
      add: {description: "添加过滤词", args: "关键词 [...]", handle: filters(true)},
      del: {description: "删除过滤词", args: "关键词 [...]", handle: filters(false)},
      list: {description: "查看过滤词", args: "", handle: guarded(async (i, ctx) => {
        const config = await database(ctx).read();
        await ctx.telegram.edit(i.message, config.adFilters.length ? `**当前广告过滤词:**\n\n${config.adFilters.join(", ")}` : "当前没有广告过滤词。", {parseMode: "markdown"});
      })},
    }, handle: guarded(async () => { throw new Error("用法: so ad <add|del|list> [关键词]"); })},
    kkp: {description: "随机速览 20 秒至 3 分钟的视频", args: "[-s] [-r]", examples: [{args: "kkp -s"}], handle: guarded((i, ctx) => search(ctx, i.message, i.args, "kkp"))},
  },
  help: [{heading: "搜索行为：", body: "先用 add 添加频道源；关键词搜索不限制视频大小和时长，优先搜索默认频道。普通搜索选匹配结果，-r 随机选择，kkp 随机速览。发送时优先转发，防剧透或转发失败时下载并发送。"},
    {heading: "命令别名：", body: "<code>{prefix}search</code> 与 <code>{prefix}so</code> 使用相同参数。"}],
  handle: guarded((i, ctx) => search(ctx, i.message, i.args)),
};
const help = (prefix: string) => renderCommandHelp("so", command, {prefix, title: "🔍 多频道视频资源搜索"});
export default function createSearch() { return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION,id:"search",description:"多频道视频资源搜索与频道源管理",settings: ctx => ({id:"search",title:"频道搜索",description:"频道搜索配置：默认频道、广告过滤",category:"插件配置",icon:"🔍",getSchema:()=>[{key:"defaultChannel",label:"默认频道",type:"string"},{key:"adFilters",label:"广告过滤词列表",type:"json"}],getValues:()=>database(ctx).read(),async setValues(patch){await database(ctx).update(current=>({...current,...patch,channelList:current.channelList,schemaVersion:1} as Config));}}),commands:{so: command, search: command}}); }
