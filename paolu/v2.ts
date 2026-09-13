import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {setTimeout as sleep} from "node:timers/promises";
import {Api, helpers, utils} from "teleproto";

const BATCH_SIZE=100,MAX_FLOOD_RETRIES=3;
type Wait=(ms:number,signal:AbortSignal)=>Promise<void>;
const wait:Wait=(ms,signal)=>sleep(ms,undefined,{signal});
function peer(chatId:string):Api.TypePeer{const[id,Peer]=utils.resolveId(helpers.returnBigInt(chatId));if(Peer===Api.PeerUser)return new Api.PeerUser({userId:id});if(Peer===Api.PeerChat)return new Api.PeerChat({chatId:id});return new Api.PeerChannel({channelId:id});}
function flood(error:unknown):number|undefined{if(!error||typeof error!=="object")return;const own=Object.getOwnPropertyDescriptor(error,"message")?.value;if(typeof own!=="string")return;const match=/FLOOD_WAIT[_ ]?(\d+)/.exec(own);if(!match)return;const seconds=Number(match[1]);return Number.isSafeInteger(seconds)&&seconds>=0&&seconds<=86400?seconds:undefined;}

export async function deleteBatch(client:any,chat:unknown,ids:readonly number[],signal:AbortSignal,pause:Wait=wait):Promise<number>{
  for(let retry=0;retry<=MAX_FLOOD_RETRIES;retry++){
    signal.throwIfAborted();
    try{await client.deleteMessages(chat,[...ids],{revoke:true});signal.throwIfAborted();return ids.length;}
    catch(error){signal.throwIfAborted();const seconds=flood(error);if(seconds===undefined||retry===MAX_FLOOD_RETRIES)break;await pause(seconds*1000,signal);signal.throwIfAborted();}
  }
  let deleted=0;
  for(const[index,id]of ids.entries()){
    signal.throwIfAborted();
    try{await client.deleteMessages(chat,[id],{revoke:true});signal.throwIfAborted();deleted++;}catch{signal.throwIfAborted();}
    if(index+1<ids.length)await pause(100,signal);
  }
  return deleted;
}
export async function cleanupReceipt(ctx:PluginContext,chat:any,id:number,signal:AbortSignal,pause:Wait=wait):Promise<void>{await pause(10000,signal);signal.throwIfAborted();await ctx.telegram.withClient(async(c,clientSignal)=>{const combined=AbortSignal.any([signal,clientSignal]);combined.throwIfAborted();await c.deleteMessages(chat,[id],{revoke:true});combined.throwIfAborted();});}

async function run(message:MessageEnvelope,ctx:PluginContext){
  const raw=message.raw as {peerId?:Api.TypePeer;isPrivate?:boolean}|undefined;
  if(raw?.isPrivate||!message.chatId.startsWith("-")){await ctx.telegram.edit(message,"❌ 仅群组可用",{parseMode:"html"});return;}
  await ctx.telegram.withClient(async(client:any,clientSignal)=>{
    const signal=AbortSignal.any([ctx.signal,clientSignal]);
    signal.throwIfAborted();const target=raw?.peerId??peer(message.chatId);const chat=await client.getEntity(target);signal.throwIfAborted();
    if(chat?.className!=="Channel"){await ctx.telegram.edit(message,"❌ 仅超级群组或频道可用",{parseMode:"html"});return;}
    let participant:any;
    try{participant=(await client.invoke(new Api.channels.GetParticipant({channel:chat,participant:new Api.InputPeerSelf()}))).participant;signal.throwIfAborted();}
    catch{signal.throwIfAborted();await ctx.telegram.edit(message,"❌ 无法确认管理员权限",{parseMode:"html"});return;}
    const rights=participant?.adminRights;
    if(participant?.className!=="ChannelParticipantCreator"&&(participant?.className!=="ChannelParticipantAdmin"||!rights?.banUsers||!rights?.deleteMessages)){
      await ctx.telegram.edit(message,"❌ 需要封禁成员和删除消息权限才能执行此操作",{parseMode:"html"});return;
    }
    await ctx.telegram.edit(message,"🚨 <b>一键跑路</b>\n\n正在处理中...",{parseMode:"html"});signal.throwIfAborted();
    let muted=false,deleted=0,failed=0;
    try{await client.invoke(new Api.messages.EditChatDefaultBannedRights({peer:chat,bannedRights:new Api.ChatBannedRights({sendMessages:true,sendMedia:true,sendStickers:true,sendGifs:true,sendGames:true,sendInline:true,sendPolls:true,changeInfo:true,inviteUsers:true,pinMessages:true,untilDate:0})}));signal.throwIfAborted();muted=true;}
    catch{signal.throwIfAborted();ctx.log.error("paolu_mute_failed");}
    let batch:number[]=[];
    for await(const item of client.iterMessages(chat,{minId:1,reverse:true})){
      signal.throwIfAborted();if(item.id===message.id)continue;batch.push(item.id);
      if(batch.length===BATCH_SIZE){const count=await deleteBatch(client,chat,batch,signal);deleted+=count;failed+=batch.length-count;batch=[];await ctx.telegram.edit(message,`🚨 <b>一键跑路</b>\n\n正在删除消息...\n已删除: ${deleted} 条`,{parseMode:"html"});signal.throwIfAborted();}
    }
    if(batch.length){const count=await deleteBatch(client,chat,batch,signal);deleted+=count;failed+=batch.length-count;}
    signal.throwIfAborted();
    try{await client.deleteMessages(chat,[message.id],{revoke:true});signal.throwIfAborted();}
    catch{signal.throwIfAborted();failed++;ctx.log.error("paolu_command_cleanup_failed");}
    const sent=await client.sendMessage(chat,{message:`${muted?"✅":"⚠️"} <b>跑路完成</b>\n\n• 全员禁言: ${muted?"成功":"失败"}\n• 已删除 ${deleted} 条消息${failed?`\n• 删除失败 ${failed} 条`:""}\n\n此消息将在10秒后自动删除`,parseMode:"html"});signal.throwIfAborted();
    void ctx.tasks.run(`paolu:cleanup:${message.chatId}:${sent.id}`,scoped=>cleanupReceipt(ctx,chat,sent.id,scoped))
      .catch(()=>{if(!ctx.signal.aborted)ctx.log.error("paolu_receipt_cleanup_failed");});
  });
}
export default function createPaolu(){return definePlugin({renderHelp:renderPluginHelp,apiVersion:1,id:"paolu",description:"删除群内消息并禁言所有成员",commands:{paolu:{description:"群组一键跑路",ignoreEdited:true,async handle({message},ctx){try{await run(message,ctx);}catch{if(!ctx.signal.aborted){ctx.log.error("paolu_failed");await ctx.telegram.edit(message,"❌ 操作失败，请稍后重试",{parseMode:"html"});}}}}}});}
