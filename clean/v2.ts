import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type MessageEnvelope, type PluginContext, type SubcommandDefinition} from "telebox/sdk";
import {setTimeout as sleep} from "node:timers/promises";

const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]!);
const err=(e:unknown)=>String((e as any)?.message??e);
const wait=async(e:unknown,signal:AbortSignal)=>{const m=err(e).match(/FLOOD_WAIT[_ ]?(\d+)/);if(!m)return false;await sleep((Number(m[1])+1)*1000,undefined,{signal});return true;};
const group=(m:MessageEnvelope)=>(m.raw as any)?.isGroup||(m.raw as any)?.isChannel||m.chatId.startsWith("-");

async function permission(client:any,chat:any,Api:any){try{const me=await client.getMe();if(chat.className==="Chat")return !!chat.creator||!!chat.adminRights;const p=(await client.invoke(new Api.channels.GetParticipant({channel:chat,participant:me.id}))).participant;return p?.className==="ChannelParticipantCreator"||(p?.className==="ChannelParticipantAdmin"&&!!p.adminRights?.banUsers);}catch{return false;}}
async function deletedPm(message:MessageEnvelope,remove:boolean,ctx:PluginContext){await ctx.telegram.edit(message,remove?"🔍 正在扫描并从对话列表中移除已注销账号...":"🔍 正在扫描私聊已注销账号...");await ctx.telegram.withClient(async(client:any,signal)=>{const found=new Map<string,any>();for(const folder of [0,1]){try{for await(const d of client.iterDialogs({folder})){signal.throwIfAborted();if(d.isUser&&d.entity?.className==="User"&&d.entity.deleted)found.set(String(d.entity.id),d);}}catch{ctx.log.error("clean:dialogs",{folder});}}
  let ok=0,failed=0;if(remove)for(const d of found.values()){try{await client.deleteDialog(d.inputEntity);ok++;await sleep(150,undefined,{signal});}catch(e){if(await wait(e,signal)){try{await client.deleteDialog(d.inputEntity);ok++;}catch{failed++;}}else failed++;}}
  const rows=[...found.keys()].slice(0,15).map(id=>`• <a href="tg://user?id=${esc(id)}">已注销账号</a> (ID: <code>${esc(id)}</code>)`).join("\n");const title=remove?"清理完成":"扫描完成";await ctx.telegram.edit(message,found.size?`✅ <b>${title}</b>\n\n共找到 <code>${found.size}</code> 个已注销对话${remove?`，成功移除 <code>${ok}</code>${failed?`，失败 <code>${failed}</code>`:""}`:""}:\n\n${rows}${found.size>15?`\n... 以及其他 ${found.size-15} 个会话`:""}`:`✅ <b>${title}</b>\n\n对话列表中未发现已注销账号。`,{parseMode:"html"});});}
async function deletedMembers(message:MessageEnvelope,remove:boolean,ctx:PluginContext){
  if(!group(message)){await ctx.telegram.edit(message,"❌ <b>错误:</b> 此命令仅在群组中可用",{parseMode:"html"});return;}
  await ctx.telegram.withClient(async(client:any,signal)=>{
    const {Api}=await import("teleproto");const raw:any=message.raw,chat=await client.getEntity(raw?.peerId??message.chatId),input=await client.getInputEntity(chat);
    if(remove&&!await permission(client,chat,Api)){await ctx.telegram.edit(message,"❌ <b>错误:</b> 没有封禁用户权限，无法执行清理",{parseMode:"html"});return;}
    await ctx.telegram.edit(message,remove?"🔍 正在扫描并清理群组已注销账号...":"🔍 正在扫描群组已注销账号...");
    const targets:any[]=[];
    for await(const user of client.iterParticipants(chat)){signal.throwIfAborted();if(user.className==="User"&&user.deleted)targets.push(user);}
    let ok=0,failed=0;const ids=targets.map(user=>String(user.id));
    if(remove)for(const user of targets){signal.throwIfAborted();try{const target=await client.getInputEntity(user);if(chat.className==="Chat")await client.invoke(new Api.messages.DeleteChatUser({chatId:chat.id,userId:target,revokeHistory:false}));else{await client.invoke(new Api.channels.EditBanned({channel:input,participant:target,bannedRights:new Api.ChatBannedRights({viewMessages:true,untilDate:0})}));await client.invoke(new Api.channels.EditBanned({channel:input,participant:target,bannedRights:new Api.ChatBannedRights({untilDate:0})}));}ok++;}catch(e){failed++;if(await wait(e,signal))ctx.log.info("clean:flood-resumed");}await sleep(150,undefined,{signal});}
    const found=targets.length,list=ids.slice(0,15).map(id=>`• <a href="tg://user?id=${esc(id)}">${esc(id)}</a>`).join("\n");
    await ctx.telegram.edit(message,found?`✅ <b>${remove?"清理":"扫描"}完成</b>\n\n发现 <code>${found}</code> 个已注销账号${remove?`\n成功移出 <code>${ok}</code> 个${failed?` · 失败 <code>${failed}</code> 个`:""}`:""}:\n\n${list}${found>15?`\n... 还有 ${found-15} 个未显示`:""}`:`✅ <b>扫描完成</b>\n\n此群组中没有发现已注销账号。`,{parseMode:"html"});
  });
}
async function blockedPm(message:MessageEnvelope,all:boolean,ctx:PluginContext){await ctx.telegram.edit(message,`🧹 开始清理拉黑用户\n\n模式: ${all?"全量清理":"智能清理"}`);await ctx.telegram.withClient(async(client:any,signal)=>{const {Api}=await import("teleproto");let offset=0,total=0;const users:any[]=[];while(true){const r:any=await client.invoke(new Api.contacts.GetBlocked({offset,limit:100}));const page=r.users||[];users.push(...page);total=Number(r.count??users.length);if(page.length<100||users.length>=total)break;offset+=page.length;}let ok=0,failed=0,skipped=0,processed=0;for(const user of users){signal.throwIfAborted();processed++;if(!all&&(user.bot||user.scam||user.fake)){skipped++;continue;}try{await client.invoke(new Api.contacts.Unblock({id:user}));ok++;}catch(e){if(await wait(e,signal)){try{await client.invoke(new Api.contacts.Unblock({id:user}));ok++;}catch{failed++;}}else failed++;}if(processed%10===0)await ctx.telegram.edit(message,`🧹 <b>清理拉黑用户进行中</b>\n\n进度: ${processed}/${total}\n成功: ${ok} · 失败: ${failed} · 跳过: ${skipped}`,{parseMode:"html"});await sleep(all?1000:200,undefined,{signal});}await ctx.telegram.edit(message,`✅ <b>清理拉黑用户完成</b>\n\n总计用户: ${total}\n成功清理: ${ok}\n清理失败: ${failed}\n跳过处理: ${skipped}\n清理模式: ${all?"全量清理":"智能清理"}`,{parseMode:"html"});});}
async function blockedMembers(message:MessageEnvelope,all:boolean,ctx:PluginContext){if(!group(message)){await ctx.telegram.edit(message,"❌ <b>错误:</b> 此命令只能在群组中使用",{parseMode:"html"});return;}await ctx.telegram.withClient(async(client:any,signal)=>{const {Api}=await import("teleproto");const raw:any=message.raw,chat=await client.getEntity(raw?.peerId??message.chatId);if(chat.className!=="Channel"){await ctx.telegram.edit(message,"❌ 基本群不支持封禁列表");return;}if(!await permission(client,chat,Api)){await ctx.telegram.edit(message,"❌ <b>错误:</b> 没有封禁用户权限",{parseMode:"html"});return;}const me=await client.getMe(),input=await client.getInputEntity(chat),targets:any[]=[],users=new Map<string,any>();let offset=0;while(true){const r:any=await client.invoke(new Api.channels.GetParticipants({channel:input,filter:new Api.ChannelParticipantsKicked({q:""}),offset,limit:200,hash:0 as any}));for(const u of r.users||[])users.set(String(u.id),u);const page=r.participants||[];targets.push(...page.filter((p:any)=>all||String(p.kickedBy)===String(me.id)));if(page.length<200)break;offset+=page.length;}let ok=0,failed=0;for(const p of targets){signal.throwIfAborted();try{const u=users.get(String(p.peer?.userId??p.userId))??p.peer??p.userId;await client.invoke(new Api.channels.EditBanned({channel:input,participant:await client.getInputEntity(u),bannedRights:new Api.ChatBannedRights({untilDate:0})}));ok++;}catch{failed++;}await sleep(500,undefined,{signal});}await ctx.telegram.edit(message,targets.length?`✅ <b>解封完成</b>\n\n成功: <code>${ok}</code> 个\n失败: <code>${failed}</code> 个`:"ℹ️ 没有找到需要解封的实体",{parseMode:"html"});});}

export default function createClean(){
  const guard=async(message:MessageEnvelope,ctx:PluginContext,body:()=>Promise<void>)=>{try{await body();}catch(e){if(!ctx.signal.aborted)await ctx.telegram.edit(message,err(e).includes("FLOOD_WAIT")?"⏳ 请求过于频繁，请稍后重试":`❌ <b>操作失败:</b> ${esc(err(e))}`,{parseMode:"html"});}};
  const scopeError=(scope:string|undefined):string=>scope?`❌ <b>错误:</b> 未知类型: ${esc(scope)}`:"❌ <b>错误:</b> 请指定清理类型: pm 或 member";
  const pmLeaf=():SubcommandDefinition=>({description:"扫描私聊中的已注销账号",args:"",
    examples:[{args:"pm"}],
    subcommands:{rm:{description:"扫描并移除已注销账号的私聊",args:"",examples:[{args:"rm"}],
      async handle(invocation,ctx){await guard(invocation.message,ctx,()=>deletedPm(invocation.message,true,ctx));}}},
    async handle(invocation,ctx){await guard(invocation.message,ctx,()=>deletedPm(invocation.message,false,ctx));}});
  const memberLeaf=():SubcommandDefinition=>({description:"扫描群组中的已注销账号",args:"",
    examples:[{args:"member"}],
    subcommands:{rm:{description:"扫描并清理群组已注销账号",args:"",examples:[{args:"rm"}],
      async handle(invocation,ctx){await guard(invocation.message,ctx,()=>deletedMembers(invocation.message,true,ctx));}}},
    async handle(invocation,ctx){await guard(invocation.message,ctx,()=>deletedMembers(invocation.message,false,ctx));}});
  const blockedPmLeaf=():SubcommandDefinition=>({description:"清理拉黑用户（智能模式：跳过机器人/诈骗/虚假账户）",args:"",
    examples:[{args:"pm"}],
    subcommands:{all:{description:"清理所有拉黑用户（全量模式）",args:"",examples:[{args:"all"}],
      async handle(invocation,ctx){await guard(invocation.message,ctx,()=>blockedPm(invocation.message,true,ctx));}}},
    async handle(invocation,ctx){await guard(invocation.message,ctx,()=>blockedPm(invocation.message,false,ctx));}});
  const blockedMemberLeaf=():SubcommandDefinition=>({description:"解封自己封禁的实体",args:"",
    examples:[{args:"member"}],
    subcommands:{all:{description:"解封所有被封禁的实体",args:"",examples:[{args:"all"}],
      async handle(invocation,ctx){await guard(invocation.message,ctx,()=>blockedMembers(invocation.message,true,ctx));}}},
    async handle(invocation,ctx){await guard(invocation.message,ctx,()=>blockedMembers(invocation.message,false,ctx));}});
  const deletedNode:SubcommandDefinition={description:"清理已注销账号",subcommands:{pm:pmLeaf(),member:memberLeaf()},
    async handle(invocation,ctx){await guard(invocation.message,ctx,async()=>{await ctx.telegram.edit(invocation.message,scopeError(invocation.args[0]?.toLowerCase()),{parseMode:"html"});});}};
  const blockedNode:SubcommandDefinition={description:"清理拉黑/封禁",subcommands:{pm:blockedPmLeaf(),member:blockedMemberLeaf()},
    async handle(invocation,ctx){await guard(invocation.message,ctx,async()=>{await ctx.telegram.edit(invocation.message,scopeError(invocation.args[0]?.toLowerCase()),{parseMode:"html"});});}};
  const clean:CommandDefinition={description:"账号与封禁清理",helpArgs:["help","h"],helpOnEmpty:true,ignoreEdited:true,
    subcommandsCaseSensitive:false,
    subcommands:{deleted:deletedNode,blocked:blockedNode},
    examples:[{args:"deleted pm"},{args:"deleted member rm"},{args:"blocked pm all"},{args:"blocked member all"}],
    help:[
      {heading:"功能概述：",body:"删除账号清理：扫描并清理已注销/删除的账号。拉黑用户清理：解除双向拉黑状态。被封禁实体解封：解封群组中被封禁的用户/频道/群组。"},
      {heading:"默认与模式：",body:"deleted pm / deleted member 默认仅扫描，附加 rm 才执行清理；blocked pm 默认智能清理（跳过机器人、诈骗、虚假账户），附加 all 为全量清理；blocked member 默认解封自己封禁的实体，附加 all 解封全部。"},
      {heading:"数据统计：",body:"处理总数、成功数、失败数、跳过数；自动处理 API 限制并实时显示进度。"},
      {heading:"权限要求：",body:"群组操作需要管理员权限；封禁清理需要封禁用户权限；私聊清理仅操作当前账号的对话。"},
    ],
    async handle(invocation,ctx){await guard(invocation.message,ctx,async()=>{const first=invocation.args[0]?.toLowerCase();const guide=()=>renderCommandHelp("clean",clean,{prefix:invocation.prefix, title: "🧹 清理工具 Pro"});await ctx.telegram.edit(invocation.message,(!invocation.args.length||first==="help"||first==="h")?guide():scopeError(invocation.args[1]?.toLowerCase()),{parseMode:"html"});});}};
  return definePlugin({apiVersion:STRUCTURED_PLUGIN_API_VERSION,id:"clean",description:"清理已注销账号、拉黑用户和群组封禁",
    renderHelp: prefix => renderCommandHelp("clean", clean, {prefix, title: "🧹 清理工具 Pro"}),
    commands:{clean}});
}
