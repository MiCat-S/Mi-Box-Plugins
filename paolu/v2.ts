import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {setTimeout as sleep} from "node:timers/promises";

const escape=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]!);
async function deletion(client:any,chat:any,ids:number[],signal:AbortSignal){
  try{await client.deleteMessages(chat,ids,{revoke:true});return ids.length;}catch(error){signal.throwIfAborted();const flood=String(error).match(/FLOOD_WAIT[_ ]?(\d+)/);if(flood){await sleep(Number(flood[1])*1000,undefined,{signal});try{await client.deleteMessages(chat,ids,{revoke:true});return ids.length;}catch{signal.throwIfAborted();}}
    let done=0;for(const id of ids){signal.throwIfAborted();try{await client.deleteMessages(chat,[id],{revoke:true});done++;}catch{}await sleep(100,undefined,{signal});}return done;}
}
async function run(message:MessageEnvelope,ctx:PluginContext){
  const raw:any=message.raw;if(raw?.isPrivate||!message.chatId.startsWith("-")){await ctx.telegram.edit(message,"❌ 仅群组可用",{parseMode:"html"});return;}
  await ctx.telegram.withClient(async(client:any,signal)=>{const {Api}=await import("teleproto");const chat=await client.getEntity(raw?.peerId??message.chatId),me=await client.getMe();let participant:any;
    try{participant=(await client.invoke(new Api.channels.GetParticipant({channel:chat,participant: new Api.InputPeerSelf()}))).participant;}catch{await ctx.telegram.edit(message,"❌ 无法确认管理员权限",{parseMode:"html"});return;}
    const rights=participant?.adminRights;if(participant?.className!=="ChannelParticipantCreator"&&(participant?.className!=="ChannelParticipantAdmin"||!rights?.banUsers||!rights?.deleteMessages)){await ctx.telegram.edit(message,"❌ 需要封禁成员和删除消息权限才能执行此操作",{parseMode:"html"});return;}
    await ctx.telegram.edit(message,"🚨 <b>一键跑路</b>\n\n正在处理中...",{parseMode:"html"});let muted=false,deleted=0,failed=0;
    try{await client.invoke(new Api.messages.EditChatDefaultBannedRights({peer:chat,bannedRights:new Api.ChatBannedRights({sendMessages:true,sendMedia:true,sendStickers:true,sendGifs:true,sendGames:true,sendInline:true,sendPolls:true,changeInfo:true,inviteUsers:true,pinMessages:true,untilDate:0})}));muted=true;}catch{ctx.log.error("paolu:mute");}
    let batch:number[]=[];for await(const item of client.iterMessages(chat,{minId:1,reverse:true})){signal.throwIfAborted();if(item.id===message.id)continue;batch.push(item.id);if(batch.length===100){const n=await deletion(client,chat,batch,signal);deleted+=n;failed+=batch.length-n;batch=[];await ctx.telegram.edit(message,`🚨 <b>一键跑路</b>\n\n正在删除消息...\n已删除: ${deleted} 条`,{parseMode:"html"});}}if(batch.length){const n=await deletion(client,chat,batch,signal);deleted+=n;failed+=batch.length-n;}
    try{await client.deleteMessages(chat,[message.id],{revoke:true});}catch{failed++;}
    const sent=await client.sendMessage(chat,{message:`${muted?"✅":"⚠️"} <b>跑路完成</b>\n\n• 全员禁言: ${muted?"成功":"失败"}\n• 已删除 ${deleted} 条消息${failed?`\n• 删除失败 ${failed} 条`:""}\n\n此消息将在10秒后自动删除`,parseMode:"html"});
    void ctx.tasks.run(`paolu:cleanup:${message.chatId}:${sent.id}`,async scoped=>{await sleep(10000,undefined,{signal:scoped});await ctx.telegram.withClient(c=>c.deleteMessages(chat,[sent.id],{revoke:true}));}).catch(()=>undefined);
  });
}
export default function createPaolu(){return definePlugin({renderHelp: renderPluginHelp, apiVersion:1,id:"paolu",description:"删除群内消息并禁言所有成员",commands:{paolu:{description:"群组一键跑路",ignoreEdited:true,async handle({message},ctx){try{await run(message,ctx);}catch(error){if(!ctx.signal.aborted)await ctx.telegram.edit(message,`❌ 操作失败: ${escape((error as any)?.message??error)}`,{parseMode:"html"});}}}}});}
