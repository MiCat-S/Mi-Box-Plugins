import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type MessageEnvelope, type PluginContext} from "telebox/sdk";

type LockData = {schemaVersion: 1; lockedSeats: Record<string, string[]>};
type CacheEntry = {updatedAt: number; avgPerDay?: number; name?: string; username?: string | null};
type CacheData = {schemaVersion: 1; values: Record<string, CacheEntry>};
type Target = {entity: any; title: string; username: string | null; channel: boolean; key: string};
type Stat = {user:any; id:string; name:string; username:string|null; rank:string; avg:number; avgText:string; last:number; lastText:string; locked:boolean; creator:boolean};
const DAY = 86_400_000, WEEK = 604_800;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#x27;"})[c]!);
const locks = (ctx: PluginContext) => ctx.storage.json<LockData>("seat_locks.json", {schemaVersion:1,lockedSeats:{}});
const cache = (ctx: PluginContext) => ctx.storage.json<CacheData>("avg_cache.json", {schemaVersion:1,values:{}});
const errorText = (error: unknown) => { const value = error instanceof Error ? error.message : String(error); return value.includes("CHAT_ADMIN_REQUIRED") ? "需要管理员权限才能执行该操作" : value.includes("CHANNEL_PRIVATE") ? "无法访问该私有频道/群组" : value.includes("USER_NOT_PARTICIPANT") ? "目标用户不在该对话中" : value.includes("RIGHT_FORBIDDEN") ? "当前账号没有足够权限执行该操作" : value.includes("USER_CREATOR") ? "群主无法被下掉管理员" : value; };
const userName = (user:any) => [user.firstName,user.lastName].filter(Boolean).join(" ") || user.username || String(user.id);
const userDisplay = (stat:Stat) => `${escape(stat.name)}${stat.username ? ` <code>@${escape(stat.username)}</code>`:""} <a href="tg://user?id=${escape(stat.id)}">${escape(stat.id)}</a>`;

async function resolveTarget(ctx: PluginContext, message: MessageEnvelope, value?: string): Promise<Target> {
  return ctx.telegram.withClient(async (client:any) => {
    const candidate:any = value ? (/^-?\d+$/.test(value) ? BigInt(value) : value) : (message.raw as any)?.peerId ?? message.chatId;
    const entity:any = await client.getEntity(candidate);
    if (!entity || !["Chat","Channel"].includes(entity.className)) throw new Error("目标必须是群组、超级群或频道");
    return {entity,title:entity.title||"未命名对话",username:entity.username ? `@${entity.username}` : null,channel:entity.className === "Channel",key:String(entity.id)};
  });
}
async function admins(ctx: PluginContext, target: Target): Promise<any[]> {
  return ctx.telegram.withClient(async (client:any) => {
    const {Api}=await import("teleproto");
    const list:any[] = await client.getParticipants(target.entity, target.channel ? {filter:new Api.ChannelParticipantsAdmins(),showTotal:false}:{showTotal:false});
    return list.filter(user => user?.className === "User" && !user.bot && (target.channel || ["ChatParticipantAdmin","ChatParticipantCreator"].includes(user.participant?.className)));
  });
}
async function stats(ctx: PluginContext, target: Target): Promise<Stat[]> {
  const users = await admins(ctx,target), lockSet = new Set((await locks(ctx).read()).lockedSeats[target.key] || []), saved = await cache(ctx).read();
  return ctx.telegram.withClient(async (client:any) => {
    const {Api}=await import("teleproto"); const result:Stat[]=[];
    for(const user of users){
      ctx.signal.throwIfAborted(); const id=String(user.id), key=`${target.key}:${id}`, hit=saved.values[key]; let avg=typeof hit?.avgPerDay === "number" && Date.now()-hit.updatedAt<DAY ? hit.avgPerDay : -1;
      if(avg<0)try{const from=await client.getInputEntity(user);const found:any=await client.invoke(new Api.messages.Search({peer:target.entity,q:"",filter:new Api.InputMessagesFilterEmpty(),minDate:Math.floor(Date.now()/1000)-WEEK,offsetId:0,addOffset:0,limit:1,maxId:0,minId:0,hash:0 as any,fromId:from}));avg=Number(found.count??found.messages?.length??0)/7;}catch{}
      let last=0;try{const found:any[]=await client.getMessages(target.entity,{fromUser:user,limit:1});last=Number(found[0]?.date||0)*1000;}catch{}
      const participant=user.participant;result.push({user,id,name:userName(user),username:user.username?String(user.username):null,rank:participant?.rank?.trim()||"无",avg,avgText:avg<0?"N/A":avg.toFixed(2).replace(/\.?0+$/, ""),last,lastText:last?`${Math.max(0,Math.floor((Date.now()-last)/DAY))} 天前`:"无记录",locked:lockSet.has(id),creator:["ChatParticipantCreator","ChannelParticipantCreator"].includes(participant?.className)});
      await cache(ctx).update(data=>({...data,values:{...data.values,[key]:{updatedAt:Date.now(),...(avg>=0?{avgPerDay:avg}:{}),name:userName(user),username:user.username||null}}}));
    }
    return result.sort((a,b)=>b.avg-a.avg||b.last-a.last||a.name.localeCompare(b.name,"zh-CN"));
  });
}
function header(target:Target, title:string, total:number, unlocked?:number){return `${title}\n目标对话: <b>${escape(target.title)}</b>${target.username?` <code>${escape(target.username)}</code>`:""}\n管理员数量: <code>${total}</code>${unlocked===undefined?"":` | 未锁席位: <code>${unlocked}</code>`}`;}
function line(stat:Stat,index:number){return `${index+1}. ${userDisplay(stat)}\n   头衔 <code>${escape(stat.rank)}</code> · 周日均 <code>${stat.avgText}</code> · 最后发言 <code>${stat.lastText}</code> · 锁定 <code>${stat.locked?"是":"否"}</code>`;}
async function send(ctx:PluginContext,message:MessageEnvelope,text:string){const chunks:string[]=[];let current="";for(const row of text.split("\n")){if(`${current}\n${row}`.length>3500){chunks.push(current);current=row;}else current+=`${current?"\n":""}${row}`;}if(current)chunks.push(current);await ctx.telegram.edit(message,chunks[0],{parseMode:"html",linkPreview:false});for(const chunk of chunks.slice(1))await ctx.telegram.reply(message,chunk,{parseMode:"html",linkPreview:false});}
async function seat(ctx:PluginContext,message:MessageEnvelope,action:"lock"|"unlock",args:readonly string[]){
  if(!args.length){await ctx.telegram.edit(message,`❌ 参数不足\n\n用法: <code>${escape(message.text.split(/\s/)[0])} ${action} 用户1,用户2 [对话id/@username]</code>`,{parseMode:"html"});return;}
  const tokens=[...args];let targetArg:string|undefined;if(tokens.length>1&&(/^@/.test(tokens.at(-1)!)||/^-?\d+$/.test(tokens.at(-1)!))&&!tokens.slice(0,-1).join(" ").includes(tokens.at(-1)!))targetArg=tokens.pop();
  const ids=tokens.join(" ").split(/[，,]/).map(v=>v.trim()).filter(v=>/^@\w{3,}$/.test(v)||/^-?\d+$/.test(v));if(!ids.length)throw new Error("用户仅支持 @username 或 ID");const target=await resolveTarget(ctx,message,targetArg);const success:string[]=[],fail:string[]=[];
  await ctx.telegram.withClient(async(client:any)=>{for(const id of ids){try{const entity:any=await client.getEntity(/^-?\d+$/.test(id)?BigInt(id):id);if(entity?.className!=="User")throw new Error("未找到用户");success.push(String(entity.id));}catch(error){if(/^-?\d+$/.test(id))success.push(id);else fail.push(`${id}（${errorText(error)}）`);}}});
  await locks(ctx).update(data=>{const set=new Set(data.lockedSeats[target.key]||[]);success.forEach(id=>action==="lock"?set.add(id):set.delete(id));const lockedSeats={...data.lockedSeats};if(set.size)lockedSeats[target.key]=[...set].sort();else delete lockedSeats[target.key];return{...data,schemaVersion:1,lockedSeats};});
  await send(ctx,message,`${action==="lock"?"🔒 席位锁定完成":"🔓 席位取消锁定完成"}\n成功: <code>${success.length}</code>\n失败: <code>${fail.length}</code>${fail.length?`\n${fail.map(v=>`• ${escape(v)}`).join("\n")}`:""}`);
}

export default function createAdminBoard(){
  const guard = (run: (invocation: CommandInvocation, ctx: PluginContext) => Promise<void>) =>
    async (invocation: CommandInvocation, ctx: PluginContext): Promise<void> => {
      try { await run(invocation, ctx); }
      catch (error) { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `❌ <b>执行失败</b>\n\n${escape(errorText(error))}`, {parseMode:"html"}); }
    };
  const lock = guard(async (invocation, ctx) => seat(ctx, invocation.message, "lock", invocation.args));
  const unlock = guard(async (invocation, ctx) => seat(ctx, invocation.message, "unlock", invocation.args));
  const clear = guard(async (invocation, ctx) => {
    const target = await resolveTarget(ctx, invocation.message, invocation.args.join(" ") || undefined);
    const prefixKey = `${target.key}:`;
    const before = await cache(ctx).read();
    const count = Object.keys(before.values).filter(key => key.startsWith(prefixKey)).length;
    await cache(ctx).update(data => ({...data, values: Object.fromEntries(Object.entries(data.values).filter(([key]) => !key.startsWith(prefixKey)))}));
    await ctx.telegram.edit(invocation.message, `🧹 <b>缓存已清理</b>\n清理条目: <code>${count}</code>`, {parseMode:"html"});
  });
  const ls = guard(async (invocation, ctx) => {
    const target = await resolveTarget(ctx, invocation.message, invocation.args.join(" ") || undefined);
    await ctx.telegram.edit(invocation.message, `📊 正在统计管理员排序简表...\n目标: <b>${escape(target.title)}</b>`, {parseMode:"html"});
    const all = await stats(ctx, target);
    await send(ctx, invocation.message, `${header(target, "📊 <b>管理员排序简表</b>", all.length)}\n\n${all.map(line).join("\n")}`);
  });
  const tail = guard(async (invocation, ctx) => {
    const numericArg = invocation.args[0] && /^\d+$/.test(invocation.args[0]);
    const count = numericArg ? Number(invocation.args[0]) : 10;
    const targetArg = numericArg ? invocation.args.slice(1).join(" ") : invocation.args.join(" ");
    const target = await resolveTarget(ctx, invocation.message, targetArg || undefined);
    if (numericArg && !/^[1-9]\d*$/.test(invocation.args[0]!)) {
      await ctx.telegram.edit(invocation.message, "❌ 参数错误\n\ntail 的人数参数必须是正整数", {parseMode:"html"}); return;
    }
    await ctx.telegram.edit(invocation.message, `📊 正在统计管理员排序简表...\n目标: <b>${escape(target.title)}</b>`, {parseMode:"html"});
    const all = await stats(ctx, target);
    const candidates = all.filter(item => !item.locked);
    const selected = candidates.slice(-count).reverse();
    await send(ctx, invocation.message, `${header(target, "📉 <b>未锁席位倒数榜</b>", all.length, candidates.length)}\n\n${selected.map(line).join("\n")||"暂无未锁定席位的管理员。"}`);
  });
  const rm = guard(async (invocation, ctx) => {
    const numericArg = invocation.args[0] && /^\d+$/.test(invocation.args[0]);
    const targetArg = numericArg ? invocation.args.slice(1).join(" ") : invocation.args.join(" ");
    const target = await resolveTarget(ctx, invocation.message, targetArg || undefined);
    if (!invocation.args[0] || !/^[1-9]\d*$/.test(invocation.args[0])) {
      await ctx.telegram.edit(invocation.message, "❌ 参数不足\n\nrm 的人数参数是必填正整数。", {parseMode:"html"}); return;
    }
    const limit = Number(invocation.args[0]);
    await ctx.telegram.edit(invocation.message, `📊 正在统计管理员排序简表...\n目标: <b>${escape(target.title)}</b>`, {parseMode:"html"});
    const all = await stats(ctx, target);
    const candidates = all.filter(item => !item.locked);
    const selected = candidates.slice(-limit).reverse();
    const success:Stat[]=[],fail:string[]=[];
    await ctx.telegram.withClient(async(client:any)=>{const {Api}=await import("teleproto");for(const stat of selected.filter(item=>!item.creator)){try{const user=await client.getInputEntity(stat.user);if(target.channel){const channel=await client.getInputEntity(target.entity);await client.invoke(new Api.channels.EditAdmin({channel,userId:user,adminRights:new Api.ChatAdminRights({}),rank:""}));}else await client.invoke(new Api.messages.EditChatAdmin({chatId:target.entity.id,userId:user,isAdmin:false}));success.push(stat);}catch(error){fail.push(`${stat.name}（${errorText(error)}）`);}}});
    await send(ctx, invocation.message, `✂️ <b>尾部管理员清理完成</b>\n目标人数: <code>${limit}</code>\n实际候选: <code>${selected.length}</code>\n成功: <code>${success.length}</code>\n失败: <code>${fail.length}</code>${fail.length?`\n${fail.map(v=>`• ${escape(v)}`).join("\n")}`:""}`);
  });
  const adminBoard: CommandDefinition = {
    description: "管理员席位管理",
    helpArgs: ["help", "h"],
    helpOnEmpty: true,
    args: "ls|tail|rm|lock|unlock|clear",
    subcommandsCaseSensitive: false,
    subcommands: {
      ls: {group: "排序简表", description: "查看当前对话管理员排序简表", args: "[对话id/@username]", examples: [{args: "ls"}, {args: "ls @group"}], handle: ls},
      tail: {group: "排序简表", description: "查看未锁定席位的倒数 N 人", args: "[人数] [对话id/@username]", examples: [{args: "tail"}, {args: "tail 20"}, {args: "tail 20 @group"}], handle: tail},
      rm: {group: "排序简表", description: "一键下掉倒数 N 个未锁定席位管理员", args: "人数 [对话id/@username]", arguments: [{name: "人数", required: true, description: "正整数"}], examples: [{args: "rm 3"}, {args: "rm 3 @group"}], handle: rm},
      lock: {group: "席位锁定", description: "锁定席位", args: "@用户名/用户id [对话id/@username]", examples: [{args: "lock @u1,@u2"}, {args: "lock 123456789"}], handle: lock},
      unlock: {group: "席位锁定", description: "取消锁定席位", args: "@用户名/用户id [对话id/@username]", examples: [{args: "unlock @u1，@u2"}], handle: unlock},
      clear: {group: "缓存", description: "清理周日均/用户信息缓存", args: "[对话id/@username]", examples: [{args: "clear"}, {args: "clear @group"}], handle: clear},
    },
    help: [
      {heading: "说明：", body: "• <code>ls</code> 是紧凑排行版；<code>tail</code> 只列出未锁定席位的倒数 N 人，默认 <code>10</code>\n• <code>rm</code> 只会下掉未锁定席位，人数参数必填且必须是正整数\n• <code>周日均</code> 和用户信息默认缓存 1 天\n• 用户和对话都只支持 <code>@username</code> 或 <code>id</code>；多个用户请用英文逗号或中文逗号分隔"},
      {heading: "ls 输出字段：", body: "用户名 / 名称 / ID / 头衔 / 周日均 / 是否已锁定 / 娱乐文案"},
    ],
    async handle(invocation, ctx) {
      const action = invocation.args[0]?.toLowerCase();
      if (!action || ["help", "h"].includes(action)) {
        await ctx.telegram.edit(invocation.message, renderCommandHelp("admin_board", adminBoard, {prefix: invocation.prefix}), {parseMode:"html"});
        return;
      }
      try {
        // Original order resolved the target before reporting an unsupported action.
        await resolveTarget(ctx, invocation.message, invocation.args.slice(1).join(" ") || undefined);
        await ctx.telegram.edit(invocation.message, `❌ <b>执行失败</b>\n\n不支持的动作: ${escape(action)}`, {parseMode:"html"});
      } catch (error) {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `❌ <b>执行失败</b>\n\n${escape(errorText(error))}`, {parseMode:"html"});
      }
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "admin_board", description: "管理员活跃度排行、席位锁定和尾部管理员清理",
    renderHelp: prefix => renderCommandHelp("admin_board", adminBoard, {prefix, title: "👮 管理员席位管理"}),
    commands: {admin_board: adminBoard}});
}
