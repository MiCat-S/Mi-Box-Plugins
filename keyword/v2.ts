import {setTimeout as sleep} from "node:timers/promises";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {returnBigInt} from "teleproto/Helpers";

type Task = {id:number; chatId:string; key:string; response:string; include:boolean; regexp:boolean; exact:boolean; caseSensitive:boolean; ignoreForward:boolean; reply:boolean; deleteSource:boolean; banSeconds:number; restrictSeconds:number; deleteReplyAfter:number; deleteSourceAfter:number};
type State = {schemaVersion:1; nextId:number; tasks:Task[]; aliases:Record<string,string>; importedLegacy:boolean; [key:string]:unknown};
const defaults:State={schemaVersion:1,nextId:1,tasks:[],aliases:{},importedLegacy:false};
const store=(ctx:PluginContext)=>ctx.storage.json<State>("config.json",defaults);
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[c]!);
const err=(e:unknown)=>e instanceof Error?e.message:String(e);

function normalizeTask(value:any):Task|undefined {
  const id=Number(value?.id??value?.task_id), chatId=value?.chatId??value?.cid;
  if(!Number.isSafeInteger(id)||id<1||chatId===undefined||typeof value?.key!=="string"||typeof (value.response??value.msg)!=="string")return;
  return {id,chatId:String(chatId),key:value.key,response:String(value.response??value.msg),include:value.include!==false,regexp:value.regexp===true,exact:value.exact===true,caseSensitive:value.caseSensitive===true||value.case===true,ignoreForward:value.ignoreForward===true||value.ignore_forward===true,reply:value.reply!==false,deleteSource:value.deleteSource===true||value.delete===true,banSeconds:Math.max(0,Number(value.banSeconds??value.ban)||0),restrictSeconds:Math.max(0,Number(value.restrictSeconds??value.restrict)||0),deleteReplyAfter:Math.max(0,Number(value.deleteReplyAfter??value.delay_delete)||0),deleteSourceAfter:Math.max(0,Number(value.deleteSourceAfter??value.source_delay_delete)||0)};
}

async function migrate(ctx:PluginContext){
  const current=await store(ctx).read(); if(current.importedLegacy)return;
  const tasks=current.tasks.map(normalizeTask).filter((x):x is Task=>!!x), aliases={...current.aliases};
  try{
    const legacy=ctx.storage.sqlite("keyword.db",{readonly:true});
    const data=await legacy.read(db=>({
      tasks:db.prepare("SELECT task_id,cid,key,msg,include,regexp,exact,case_sensitive,ignore_forward,reply,delete_msg,ban,restrict,delay_delete,source_delay_delete FROM keyword_tasks ORDER BY task_id").all() as any[],
      aliases:db.prepare("SELECT from_cid,to_cid FROM keyword_alias").all() as any[],
    }));
    const existing=new Set(tasks.map(t=>t.id));
    for(const row of data.tasks){const task=normalizeTask({...row,caseSensitive:Number(row.case_sensitive)===1,ignoreForward:Number(row.ignore_forward)===1,deleteSource:Number(row.delete_msg)===1,include:Number(row.include)===1,regexp:Number(row.regexp)===1,exact:Number(row.exact)===1,reply:Number(row.reply)===1});if(task&&!existing.has(task.id)){tasks.push(task);existing.add(task.id);}}
    for(const row of data.aliases)aliases[String(row.from_cid)]=String(row.to_cid);
  }catch{/* A missing legacy database is normal for a fresh install. */}
  tasks.sort((a,b)=>a.id-b.id);
  await store(ctx).update(value=>({...value,schemaVersion:1,tasks,aliases,nextId:Math.max(Number(value.nextId)||1,...tasks.map(t=>t.id+1)),importedLegacy:true}));
}

function parseTask(text:string,id:number,chatId:string):Task{
  const parts=text.split("\n+++\n"); if(parts.length<2||parts.some(x=>x===""))throw new Error("任务格式无效");
  const task:Task={id,chatId,key:parts[0],response:parts[1],include:true,regexp:false,exact:false,caseSensitive:false,ignoreForward:false,reply:true,deleteSource:false,banSeconds:0,restrictSeconds:0,deleteReplyAfter:0,deleteSourceAfter:0};
  for(const option of (parts[2]??"").split(/\s+/).filter(Boolean)){if(option==="include")task.include=true;else if(option==="exact"){task.include=false;task.exact=true;}else if(option==="regexp")task.regexp=true;else if(option==="case")task.caseSensitive=true;else if(option==="ignore_forward")task.ignoreForward=true;else throw new Error("任务格式无效");}
  for(const action of (parts[3]??"").split(/\s+/).filter(Boolean)){if(action==="reply")task.reply=true;else if(action==="delete")task.deleteSource=true;else if(/^ban\d*$/.test(action))task.banSeconds=Number(action.slice(3))||0;else if(/^restrict\d*$/.test(action))task.restrictSeconds=Number(action.slice(8))||0;else throw new Error("任务格式无效");}
  task.deleteReplyAfter=Number(parts[4]??0);task.deleteSourceAfter=Number(parts[5]??0);
  if(![task.deleteReplyAfter,task.deleteSourceAfter,task.banSeconds,task.restrictSeconds].every(Number.isFinite)||[task.deleteReplyAfter,task.deleteSourceAfter,task.banSeconds,task.restrictSeconds].some(v=>v<0))throw new Error("时间参数不能为负数");
  if(task.regexp)try{new RegExp(task.key,task.caseSensitive?"g":"gi");}catch{throw new Error("正则表达式无效");}
  return task;
}

function matches(task:Task,message:MessageEnvelope){if(!message.text||(task.ignoreForward&&message.forwarded))return false;let text=message.text,key=task.key;if(task.regexp)return new RegExp(key,task.caseSensitive?"g":"gi").test(text);if(!task.caseSensitive){text=text.toLowerCase();key=key.toLowerCase();}return task.exact?text===key:task.include&&text.includes(key);}
function response(task:Task,message:MessageEnvelope){const raw=message.raw as any;const sender=raw?.sender;const name=String(sender?.firstName??sender?.first_name??"User");const id=message.senderId??"";return task.response.replace("$mention",id?`<a href="tg://user?id=${esc(id)}">${esc(name)}</a>`:"").replace("$code_id",esc(id)).replace("$code_name",esc(name)).replace("$delay_delete",task.deleteReplyAfter?String(task.deleteReplyAfter):"");}
async function delayedDelete(ctx:PluginContext,chatId:string,id:number,seconds:number,label:string){await ctx.tasks.run(label,async signal=>{if(seconds)await sleep(seconds*1000,undefined,{signal});await ctx.telegram.withClient(async client=>client.deleteMessages(returnBigInt(chatId),[id],{revoke:true}));});}
async function moderate(ctx:PluginContext,message:MessageEnvelope,task:Task){if(!message.senderId||(!task.banSeconds&&!task.restrictSeconds))return;await ctx.telegram.withClient(async client=>{const {Api}=await import("teleproto");const raw=message.raw as any;const channel=await client.getInputEntity(raw?.peerId??returnBigInt(message.chatId));const user=await client.getInputEntity(returnBigInt(message.senderId!));const until=Math.floor(Date.now()/1000)+(task.banSeconds||task.restrictSeconds);await client.invoke(new Api.channels.EditBanned({channel,participant:user,bannedRights:new Api.ChatBannedRights(task.banSeconds?{viewMessages:true,untilDate:until}:{sendMessages:true,untilDate:until})}));});}
async function apply(ctx:PluginContext,message:MessageEnvelope,task:Task){
  let sentId:number|undefined;
  await ctx.telegram.withClient(async client=>{const raw=message.raw as any;const sent=await client.sendMessage(raw?.peerId??returnBigInt(message.chatId),{message:response(task,message),parseMode:"html",...(task.reply?{replyTo:message.id}:{})});sentId=sent.id;});
  await moderate(ctx,message,task);
  if(task.deleteSource)void delayedDelete(ctx,message.chatId,message.id,task.deleteSourceAfter,`keyword:source:${message.chatId}:${message.id}:${task.id}`).catch(e=>{if(!ctx.signal.aborted)ctx.log.error("keyword:delete-source",{error:err(e).slice(0,300)});});
  if(task.deleteReplyAfter&&sentId)void delayedDelete(ctx,message.chatId,sentId,task.deleteReplyAfter,`keyword:reply:${message.chatId}:${sentId}`).catch(e=>{if(!ctx.signal.aborted)ctx.log.error("keyword:delete-reply",{error:err(e).slice(0,300)});});
}

const help=(prefix:string)=>`<b>关键词回复</b>\n<code>${prefix}keyword list [all]</code>\n<code>${prefix}keyword rm 1,2</code>\n<code>${prefix}keyword alias 群ID|rm</code>\n添加格式：关键词、回复、选项、动作和延迟用单独一行 <code>+++</code> 分隔。`;

const keywordPlugin=definePlugin({apiVersion:1,id:"keyword",description:"按聊天配置关键词回复、删除和成员处置",commands:{keyword:{description:"管理关键词回复",async handle({message,args,prefix},ctx){try{
  const state=await store(ctx).read(),action=args[0]?.toLowerCase();
  if(!action||action==="h"||action==="help"){await ctx.telegram.edit(message,help(prefix),{parseMode:"html"});return;}
  if(action==="list"){const all=args[1]==="all",items=all?state.tasks:state.tasks.filter(t=>t.chatId===message.chatId);await ctx.telegram.edit(message,items.length?items.map(t=>`<code>${t.id}</code> - <code>${esc(t.key)}</code>${all?` - <code>${esc(t.chatId)}</code>`:""} - ${esc(t.response)}`).join("\n"):all?"当前没有任何关键词任务":"当前聊天没有任何关键词任务",{parseMode:"html"});return;}
  if(action==="rm"){const ids=(args[1]??"").split(",").map(Number);if(!ids.length||ids.some(x=>!Number.isSafeInteger(x)))throw new Error("请输入正确的任务 ID");let removed=0;await store(ctx).update(value=>({...value,tasks:value.tasks.filter(t=>ids.includes(t.id)?(removed++,false):true)}));await ctx.telegram.edit(message,`已删除 <code>${removed}</code> 个任务。`,{parseMode:"html"});return;}
  if(action==="alias"){const target=args[1];if(!target){await ctx.telegram.edit(message,state.aliases[message.chatId]?`当前群组继承自：<code>${esc(state.aliases[message.chatId])}</code>`:"当前群组没有继承设置",{parseMode:"html"});return;}await store(ctx).update(value=>{const aliases={...value.aliases};if(target==="rm")delete aliases[message.chatId];else aliases[message.chatId]=String(target);return{...value,aliases};});await ctx.telegram.edit(message,target==="rm"?"已删除继承设置":`已添加继承：<code>${esc(target)}</code>`,{parseMode:"html"});return;}
  const raw=message.text.slice(message.text.indexOf(" ")+1);const task=parseTask(raw,state.nextId,message.chatId);await store(ctx).update(value=>({...value,nextId:Math.max(value.nextId,task.id+1),tasks:[...value.tasks,task]}));await ctx.telegram.edit(message,`已添加关键词任务，ID 为 <code>${task.id}</code>。`,{parseMode:"html"});
}catch(e){if(!ctx.signal.aborted)await ctx.telegram.edit(message,`操作失败：<code>${esc(err(e))}</code>`,{parseMode:"html"});}}}},listeners:[{edited:false,ignoreCommands:false,async handle(message,ctx){if(message.outgoing||!message.text)return;const state=await store(ctx).read();const inherited=state.aliases[message.chatId];const ordered=[...(inherited?state.tasks.filter(t=>t.chatId===inherited):[]),...state.tasks.filter(t=>t.chatId===message.chatId)];for(const task of ordered){ctx.signal.throwIfAborted();if(matches(task,message))await apply(ctx,message,task);}}}],async setup(ctx){await migrate(ctx);}});
export default function createKeyword(){return keywordPlugin;}
