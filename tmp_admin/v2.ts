import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {setTimeout as sleep} from "node:timers/promises";
import {returnBigInt} from "teleproto/Helpers";

type StoredJob = {chatId:string; userId:string; display:string; expiresAt:number; originalRank:string; replyToId?:number; retryCount:number; channelAccessHash?:string; userAccessHash?:string};
type Data = {schemaVersion:1; jobs:Record<string, StoredJob>; enabled:boolean};
type LiveJob = StoredJob & {dispose:()=>Promise<void>};
const defaults:Data={schemaVersion:1,jobs:{},enabled:true};
const title="临时管理", retryDelay=60_000;
const escape=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[c]!);
const key=(chatId:string,userId:string)=>`${chatId}:${userId}`;
const error=(value:unknown)=>value instanceof Error?value.message:String(value);
const temporary=(participant:any)=>participant?.className==="ChannelParticipantAdmin"&&participant.rank===title&&!!participant.adminRights?.other&&!["changeInfo","postMessages","editMessages","deleteMessages","banUsers","inviteUsers","pinMessages","addAdmins","anonymous","manageCall","manageTopics","postStories","editStories","deleteStories","manageDirectMessages","manageRanks"].some(name=>participant.adminRights?.[name]);

function database(ctx:PluginContext){return ctx.storage.json<Data>("jobs.json",defaults);}
function duration(raw?:string){if(!raw)return 30;const value=Number(raw);if(!Number.isFinite(value)||value<=0||value>525_600)throw new Error("时长必须是大于 0 且不超过 525600 的分钟数");return value;}
async function entity(ctx:PluginContext,message:MessageEnvelope,inputChannel:any,arg?:string){
  return ctx.telegram.withClient(async(client:any,signal)=>{
    const {Api}=await import("teleproto");
    const result=(full:any,input:any,id:string)=>({full,input,id,display:[full?.firstName,full?.lastName].filter(Boolean).join(" ")||full?.username||id});
    if(message.replyToId){
      const reply=await ctx.telegram.getReply(message),raw=reply?.raw as any;
      if(!reply)throw new Error("请回复一条消息或提供 用户ID/用户名");
      let sender:any;
      try{sender=await raw?.getSender?.();}catch{signal.throwIfAborted();}
      if(sender instanceof Api.User){
        return result(sender,await client.getInputEntity(sender.id),String(sender.id));
      }
      const id=raw?.fromId?.userId??reply.senderId;
      if(id){
        const input=await client.getInputEntity(returnBigInt(String(id))),full=await client.getEntity(input);
        if(full instanceof Api.User)return result(full,input,String(full.id));
      }
      throw new Error("请回复一条消息或提供 用户ID/用户名");
    }
    if(!arg)throw new Error("请回复一条消息或提供 用户ID/用户名");
    try{
      const full=await client.getEntity(arg);
      if(full?.className!=="User")throw new Error("目标必须是用户");
      return result(full,await client.getInputEntity(full.id),String(full.id));
    }catch(error){
      signal.throwIfAborted();
      const numeric=Number(arg);
      if(!Number.isFinite(numeric))throw error;
      let offset=0;
      for(let page=0;page<5;page++){
        signal.throwIfAborted();
        const found:any=await client.invoke(new Api.channels.GetParticipants({channel:inputChannel,filter:new Api.ChannelParticipantsRecent(),offset,limit:200,hash:0 as any}));
        const participants:any[]=found.participants??[],users:any[]=found.users??[];
        if(participants.some(p=>Number(p.userId)===numeric)){
          const user=users.find(u=>Number(u.id)===numeric);
          if(user)return result(user,await client.getInputEntity(user),String(user.id));
        }
        if(!participants.length)break;
        offset+=participants.length;
      }
      throw new Error("请回复一条消息或提供 用户ID/用户名");
    }
  });
}
async function channel(ctx:PluginContext,message:MessageEnvelope){return ctx.telegram.withClient(async(client:any)=>{const full=await client.getEntity((message.raw as any)?.peerId??message.chatId);if(full?.className!=="Channel")throw new Error("请在超级群/频道中使用该命令");return{full,input:await client.getInputEntity(full)};});}
async function participant(ctx:PluginContext,input:any,user:any){return ctx.telegram.withClient(async(client:any)=>{const {Api}=await import("teleproto");const result:any=await client.invoke(new Api.channels.GetParticipant({channel:input,participant:user}));return result?.participant;});}
async function setAdmin(ctx:PluginContext,input:any,user:any,rank:string,grant:boolean){await ctx.telegram.withClient(async(client:any)=>{const {Api}=await import("teleproto");await client.invoke(new Api.channels.EditAdmin({channel:input,userId:user,adminRights:new Api.ChatAdminRights(grant?{other:true}:{}),rank}));});}
async function storedPeers(ctx:PluginContext,job:StoredJob){return ctx.telegram.withClient(async(client:any)=>{if(job.channelAccessHash&&job.userAccessHash){const {Api}=await import("teleproto");return{channel:new Api.InputChannel({channelId:returnBigInt(job.chatId),accessHash:returnBigInt(job.channelAccessHash)}),user:new Api.InputUser({userId:returnBigInt(job.userId),accessHash:returnBigInt(job.userAccessHash)})};}return{channel:await client.getInputEntity(returnBigInt(job.chatId)),user:await client.getInputEntity(returnBigInt(job.userId))};});}
function normalizeJob(value:any):StoredJob|undefined{const chatId=value?.chatId??value?.chatKey??value?.channel?.channelId,userId=value?.userId??value?.user?.userId,expiresAt=Number(value?.expiresAt);if(chatId===undefined||userId===undefined||!Number.isFinite(expiresAt))return;return{chatId:String(chatId),userId:String(userId),display:String(value.display??value.userDisplay??userId),expiresAt,originalRank:String(value.originalRank??""),...(Number.isSafeInteger(value.replyToId??value.replyToMsgId)?{replyToId:Number(value.replyToId??value.replyToMsgId)}:{}),retryCount:Number.isSafeInteger(value.retryCount)?value.retryCount:0,...(value.channelAccessHash??value.channel?.accessHash?{channelAccessHash:String(value.channelAccessHash??value.channel.accessHash)}:{}),...(value.userAccessHash??value.user?.accessHash?{userAccessHash:String(value.userAccessHash??value.user.accessHash)}:{})};}

export default function createTmpAdmin(){const live=new Map<string,LiveJob>();let context:PluginContext|undefined;
  const forget=async(id:string)=>{const current=live.get(id);live.delete(id);await current?.dispose();await database(context!).update(data=>{const jobs={...data.jobs};delete jobs[id];return{...data,schemaVersion:1,jobs};});};
  const notify=async(job:StoredJob,text:string)=>{if(!context||context.signal.aborted)return;await context.telegram.withClient(async(client:any)=>{const {Api}=await import("teleproto");const peer=job.channelAccessHash?new Api.InputPeerChannel({channelId:returnBigInt(job.chatId),accessHash:returnBigInt(job.channelAccessHash)}):await client.getInputEntity(returnBigInt(job.chatId));await client.sendMessage(peer,{message:text,parseMode:"html",...(job.replyToId?{replyTo:job.replyToId}:{})});});};
  const schedule=async(id:string,job:StoredJob)=>{
    await live.get(id)?.dispose();
    const ctx=context!;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const dispose=ctx.tasks.add(`tmp_admin:${id}`,()=>{if(timer)clearTimeout(timer);if(live.get(id)===active)live.delete(id);});
    const active:LiveJob={...job,dispose};
    const scheduleWithDelay=(delay:number)=>{
      timer=setTimeout(()=>{void ctx.tasks.run(`tmp_admin:expire:${id}`,async signal=>{
        if(Date.now()<job.expiresAt){scheduleNext();return;}
        try{
          const peers=await storedPeers(ctx,job);
          const current=await participant(ctx,peers.channel,peers.user);
          signal.throwIfAborted();
          if(!temporary(current)){
            await forget(id);
            await notify(job,`临时管理员已到期, 但 ${escape(job.display)} 已不再是插件设置的临时管理状态, 未自动解除。`);
            return;
          }
          await setAdmin(ctx,peers.channel,peers.user,job.originalRank,false);
        }catch(e){
          signal.throwIfAborted();
          if(job.retryCount<1){
            job.retryCount++;
            await database(ctx).update(data=>({...data,jobs:{...data.jobs,[id]:job}}));
            scheduleWithDelay(retryDelay);
          }else{
            await forget(id);
            await notify(job,`临时管理员到期自动解除失败, 已重试 1 次: <code>${escape(error(e))}</code>`);
          }
          return;
        }
        await forget(id);
        await notify(job,`临时管理员已到期并自动解除: ${escape(job.display)}`);
      }).catch(()=>{if(!ctx.signal.aborted)ctx.log.error("tmp_admin:expiry");});},Math.min(Math.max(0,delay),2_147_483_647));
    };
    const scheduleNext=()=>scheduleWithDelay(job.expiresAt-Date.now());
    live.set(id,active);
    scheduleNext();
  };
  const help=(prefix:string)=>`使用 <code>${prefix}tmp_admin add [分钟]</code> 回复消息，或 <code>${prefix}tmp_admin add 用户 [分钟]</code>；<code>${prefix}tmp_admin rm 用户</code> 提前解除；<code>${prefix}tmp_admin ls</code> 查看任务。`;
  return definePlugin({renderHelp: renderPluginHelp, apiVersion:1,id:"tmp_admin",description:"设置会自动到期的无权限临时管理员",
    settings:ctx=>({id:"tmp_admin",title:"临时管理",description:"临时管理员配置",category:"插件配置",icon:"🛡️",getSchema:()=>[{key:"enabled",label:"启用",type:"boolean"}],getValues:async()=>{const data=await database(ctx).read();return{enabled:data.enabled!==false};},setValues:async patch=>{await database(ctx).update(data=>({...data,schemaVersion:1,enabled:typeof patch.enabled==="boolean"?patch.enabled:data.enabled}));}}),
    async setup(ctx){context=ctx;const data=await database(ctx).read();const migrated:Record<string,StoredJob>={};for(const value of Object.values(data.jobs||{})){const job=normalizeJob(value);if(job){const id=key(job.chatId,job.userId);migrated[id]=job;await schedule(id,job);}}if(data.schemaVersion!==1||Object.keys(migrated).some(id=>!(id in (data.jobs||{}))))await database(ctx).update(value=>({...value,schemaVersion:1,enabled:value.enabled!==false,jobs:migrated}));},
    async cleanup(){for(const job of [...live.values()])await job.dispose();live.clear();context=undefined;},
    commands:{tmp_admin:{helpArgs: ["help","h"], helpOnEmpty: true, description:"设置、解除或查看临时管理员",async handle({message,args,prefix},ctx){try{const data=await database(ctx).read();if(data.enabled===false){await ctx.telegram.edit(message,"临时管理员功能当前已关闭");return;}const action=args[0]?.toLowerCase();if(!action||["help","h"].includes(action)){await ctx.telegram.edit(message,help(prefix),{parseMode:"html"});return;}const chat=await channel(ctx,message);if(["ls","list"].includes(action)){const jobs=Object.values((await database(ctx).read()).jobs).filter(job=>job.chatId===String(chat.full.id));await ctx.telegram.edit(message,jobs.length?`当前临时管理员：\n${jobs.map(job=>`- ${escape(job.display)} | 剩余 <code>${Math.max(0,Math.ceil((job.expiresAt-Date.now())/60_000))} 分钟</code>`).join("\n")}`:"当前没有等待自动解除的临时管理员",{parseMode:"html"});return;}if(!["add","set","rm","remove","del"].includes(action)){await ctx.telegram.edit(message,help(prefix),{parseMode:"html"});return;}const adding=action==="add"||action==="set";const target=await entity(ctx,message,chat.input,message.replyToId?undefined:args[1]);const id=key(String(chat.full.id),target.id);const current=await participant(ctx,chat.input,target.input);if(adding){if(current?.className==="ChannelParticipantCreator")throw new Error("不能把群主设置为临时管理员");if(current?.className==="ChannelParticipantAdmin"&&!temporary(current)){if(data.jobs[id])await forget(id);throw new Error("目标已经是管理员。为避免覆盖现有权限和头衔, 不会将其改为临时管理员。");}const minutes=duration(message.replyToId?args[1]:args[2]);const job:StoredJob={chatId:String(chat.full.id),userId:target.id,display:target.display,expiresAt:Date.now()+minutes*60_000,originalRank:data.jobs[id]?.originalRank??(temporary(current)?"":String(current?.rank||"")),replyToId:message.id,retryCount:0,channelAccessHash:String(chat.input.accessHash),userAccessHash:String(target.input.accessHash)};await setAdmin(ctx,chat.input,target.input,title,true);await schedule(id,job);let warning="";try{await database(ctx).update(value=>({...value,schemaVersion:1,jobs:{...value.jobs,[id]:job}}));}catch(e){ctx.signal.throwIfAborted();warning=`\n持久化失败: <code>${escape(error(e))}</code>`;}
await sleep(1200,undefined,{signal:ctx.signal});try{if(!temporary(await participant(ctx,chat.input,target.input)))warning+="\n状态校验未确认, 已保留到期解除任务。若服务端稍后同步, 到期仍会尝试解除。";}catch(e){ctx.signal.throwIfAborted();warning+=`\n状态校验失败, 已保留到期解除任务: <code>${escape(error(e))}</code>`;}await ctx.telegram.edit(message,`已设置临时管理员: ${escape(target.display)}\n头衔: <code>${title}</code>\n时长: <code>${minutes} 分钟</code>${warning}`,{parseMode:"html"});}else{const stored=(await database(ctx).read()).jobs[id];if(!temporary(current)){if(stored)await forget(id);await ctx.telegram.edit(message,stored?"目标当前已不再是插件设置的临时管理状态, 已清理记录, 未解除管理员。":"目标不是当前插件记录的临时管理员, 也没有临时管理头衔。为避免误删真实管理员, 已取消。");return;}await setAdmin(ctx,chat.input,target.input,stored?.originalRank||"",false);await forget(id);await ctx.telegram.edit(message,`已提前解除临时管理员: ${escape(target.display)}`,{parseMode:"html"});}}catch(e){if(!ctx.signal.aborted)await ctx.telegram.edit(message,`操作失败：<code>${escape(error(e))}</code>`,{parseMode:"html"});}}}},
  });}
