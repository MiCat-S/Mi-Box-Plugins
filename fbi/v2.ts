import {renderHelp as renderPluginHelp} from "./v2/help";
import {readFile} from "node:fs/promises";
import {definePlugin,type PluginContext,type MessageEnvelope} from "telebox/sdk";
import {returnBigInt} from "teleproto/Helpers";
import {activity,MAX_MESSAGES,mergeMessages,prune,restore,trimGroups,upsert,type Cached,type Chat} from "./v2/cache";
type Watch={targetId:string;targetName:string;triggerPeer:string;triggerMsgId:number;scopePeer?:string};
type Config={schemaVersion:1;surveillance:Record<string,Watch>;cacheLimit:number;importedLegacy:boolean;[key:string]:unknown};type Cache={schemaVersion:1;cache:Record<string,Chat>;importedLegacy:boolean;[key:string]:unknown};
const cfgDefault:Config={schemaVersion:1,surveillance:{},cacheLimit:300,importedLegacy:false},cacheDefault:Cache={schemaVersion:1,cache:{},importedLegacy:false},MAX_GROUPS=1000;
const cfg=(c:PluginContext)=>c.storage.json<Config>("db.json",cfgDefault),cacheStore=(c:PluginContext)=>c.storage.json<Cache>("cache.json",cacheDefault);
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[x]!);
const peerId=(v:unknown)=>String(v??"").replace(/^-100/,"");
const normalizeConfig=(v:any):Config=>({...v,schemaVersion:1,surveillance:typeof v?.surveillance==="object"&&v.surveillance&&!Array.isArray(v.surveillance)?v.surveillance:{},cacheLimit:Math.max(10,Math.min(MAX_GROUPS,Number.isSafeInteger(Number(v?.cacheLimit))?Number(v.cacheLimit):300)),importedLegacy:true});
const normalizeCache=(v:any):Cache=>({...v,schemaVersion:1,cache:typeof v?.cache==="object"&&v.cache&&!Array.isArray(v.cache)?v.cache:{},importedLegacy:true});
const delay=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(done,ms);function done(){signal.removeEventListener("abort",abort);resolve();}function abort(){clearTimeout(timer);reject(signal.reason);}signal.addEventListener("abort",abort,{once:true});});
async function migrate(c:PluginContext){const current=await cfg(c).read();if(!current.importedLegacy){let source:any=current;try{source={...JSON.parse(await readFile(c.files.dataPath("db.json"),"utf8")),...current};}catch{}await cfg(c).update(()=>normalizeConfig(source));}const old=await cacheStore(c).read();if(!old.importedLegacy){let source:any=old;try{source={...JSON.parse(await readFile(c.files.dataPath("cache.json"),"utf8")),...old};}catch{}await cacheStore(c).update(()=>normalizeCache(source));}}
const stripped=(m:MessageEnvelope):Cached=>({id:m.id,senderId:String(m.senderId??""),date:Number((m.raw as any)?.date??Math.floor(Date.now()/1000)),text:m.text.slice(0,4096)});
function link(peer:string,chat:Chat,msg:Cached){const text=esc(msg.text.slice(0,50)||"[媒体消息]");return chat.username?`<a href="https://t.me/${encodeURIComponent(chat.username)}/${msg.id}">${text}</a>`:`<a href="https://t.me/c/${peerId(peer)}/${msg.id}">${text}</a>`;}
async function target(c:PluginContext,message:MessageEnvelope,arg?:string){if(!arg&&message.replyToId){const reply=await c.telegram.getReply(message);if(reply?.senderId)arg=reply.senderId;}if(!arg)return;return c.telegram.withClient(async client=>{try{const key:any=/^-?\d+$/.test(arg!)?returnBigInt(arg!):arg!;const e:any=await client.getEntity(key);const id=String(e?.id??arg).replace(/^@/,"");const plain=esc([e?.firstName,e?.lastName].filter(Boolean).join(" ")||e?.title||id);return{id,name:e?.username?`<a href="https://t.me/${encodeURIComponent(e.username)}">${plain}</a>`:plain};}catch{return{id:arg!.replace(/^@/,""),name:esc(arg!)};}});}
const help=(p:string)=>`<b>FBI 跨群组追踪</b>\n<code>${p}fbi det [目标]</code>\n<code>${p}fbi sur [目标]</code>\n<code>${p}fbi obs [群链接] [目标]</code>\n<code>${p}fbi loc [目标]</code>\n<code>${p}fbi ssv</code>\n<code>${p}fbi cache [limit 数量|rebuild]</code>`;
export default function createFbi(){let context:PluginContext|undefined,chats=new Map<string,Chat>(),watches=new Map<string,Watch>(),rebuilding=false,cacheLimit=300,activityClock=0,rebuildIncrements=new Map<string,Map<number,Cached>>();
 const persist=async()=>{const active=context;if(!active)return;await cacheStore(active).update(v=>({...v,schemaVersion:1,cache:Object.fromEntries(chats),importedLegacy:true}));};
 const schedule=async()=>{try{await persist();}catch(error){if(!context?.signal.aborted)context?.log.error("fbi_cache_persist_failed");throw error;}};
 const touch=(peer:string,chat:Chat)=>{
  chat.lastActiveAt=activityClock=Math.max(Date.now(),activityClock+1);
  chats.delete(peer);chats.set(peer,chat);trimGroups(chats,cacheLimit);
 };
 const trimIncrements=()=>{while(rebuildIncrements.size>cacheLimit){const oldest=rebuildIncrements.keys().next().value;if(oldest===undefined)break;rebuildIncrements.delete(oldest);}};
 const recordIncrement=(peer:string,message:Cached)=>{
  let entries=rebuildIncrements.get(peer);
  if(entries)rebuildIncrements.delete(peer);
  else entries=new Map();
  entries.set(message.id,message);
  // Bound each peer's increment so a long rebuild cannot grow it without limit.
  if(entries.size>MAX_MESSAGES){
   let oldestId:number|undefined,oldestDate=Infinity;
   for(const [id,item] of entries)if(item.date<oldestDate||(item.date===oldestDate&&(oldestId===undefined||id<oldestId))){oldestDate=item.date;oldestId=id;}
   if(oldestId!==undefined)entries.delete(oldestId);
  }
  rebuildIncrements.set(peer,entries);
  // Keep the outer peer set bounded to the same limit as the live cache.
  trimIncrements();
 };
 const applyLimit=async(state:Config)=>{
  cacheLimit=state.cacheLimit;
  for(const chat of chats.values())prune(chat);
  trimGroups(chats,cacheLimit);trimIncrements();await schedule();
 };
 const rebuild=async(c:PluginContext)=>{
  if(rebuilding)throw new Error("缓存正在重建");
  rebuilding=true;
  rebuildIncrements.clear();
  try{
   const limit=normalizeConfig(await cfg(c).read()).cacheLimit;
   const fresh=new Map<string,Chat>();
   await c.telegram.withClient(async(client,signal)=>{
    const dialogs:any[]=await client.getDialogs({limit});
    for(const d of dialogs.slice(0,limit)){
     signal.throwIfAborted();
     if(!(d?.isGroup||d?.isChat))continue;
     let entity:any;try{entity=await client.getEntity(d.id);}catch{continue;}
     if(!entity?.username)continue;
     const msgs:Cached[]=[];
     for await(const m of client.iterMessages(d.id,{limit:MAX_MESSAGES})){
      signal.throwIfAborted();
      msgs.push({id:Number(m.id),senderId:String(m.senderId??""),date:Number(m.date??0),text:String(m.text??"").slice(0,4096)});
     }
     fresh.set(String(d.id),{username:String(entity.username),title:String(entity.title??entity.username),msgs});
     await delay(250,signal);
    }
   });
   // Listeners keep accepting messages while Telegram history is fetched.
   // Merge their bounded increments over the fetched history by id instead of
   // treating the whole old cache as a live increment.
   const merged=new Map<string,Chat>(fresh);
   for(const [peer,increments] of rebuildIncrements){
    const fetched=merged.get(peer);
    const existing=chats.get(peer);
    if(!fetched&&!existing)continue;
    // Keep the existing chat's unknown fields and real-time lastActiveAt;
    // username/title may come from this fetch.
    const base:Chat=existing??fetched!;
    const template:Chat=fetched?{...base,
      ...(fetched.username!==undefined?{username:fetched.username}:{}),
      ...(fetched.title!==undefined?{title:fetched.title}:{})}:{...base};
    merged.set(peer,{...template,msgs:mergeMessages(fetched?.msgs??[],increments.values(),existing?.msgs??[])});
   }
   chats=restore(Object.fromEntries(merged),cacheLimit).chats;
   await persist();
  }finally{rebuildIncrements.clear();rebuilding=false;}
 };
 return definePlugin({renderHelp: renderPluginHelp, apiVersion:1,id:"fbi",description:"跨群组消息追踪与公开群缓存",commands:{fbi:{helpOnEmpty: true, description:"搜索、监视或定位用户",ignoreEdited:true,async handle({message,args,prefix},c){try{const sub=args[0]?.toLowerCase();if(!sub){await c.telegram.edit(message,help(prefix),{parseMode:"html"});return;}if(sub==="ssv"){watches.clear();await cfg(c).update(v=>({...v,surveillance:{}}));await c.telegram.edit(message,"已终止所有蹲守任务");return;}if(sub==="cache"){if(args[1]==="limit"){const n=Number(args[2]);if(!Number.isInteger(n)||n<10||n>MAX_GROUPS)throw new Error("缓存上限须为 10 至 1000");await applyLimit(normalizeConfig(await cfg(c).update(v=>normalizeConfig({...v,cacheLimit:n}))));await c.telegram.edit(message,`缓存上限已设置为 ${n}`);return;}if(args[1]==="rebuild"){await c.telegram.edit(message,"正在重建公开群缓存…");await rebuild(c);await c.telegram.edit(message,`缓存重建完成，共 ${chats.size} 个群组`);return;}const state=normalizeConfig(await cfg(c).read());await c.telegram.edit(message,`缓存群组：${chats.size}\n缓存上限：${state.cacheLimit}\n状态：${rebuilding?"重建中":"就绪"}`);return;}let arg=args[1],scope:string|undefined;if(sub==="obs"&&arg&&/^(?:https?:\/\/)?t\.me\//i.test(arg)){const username=arg.replace(/^(?:https?:\/\/)?t\.me\//i,"").split(/[/?#]/)[0]!.toLowerCase();for(const [id,chat] of chats)if(chat.username?.toLowerCase()===username)scope=id;if(!scope)scope=await c.telegram.withClient(async client=>String((await client.getEntity(username) as any)?.id??""));arg=args[2];}else if(sub==="obs")scope=message.chatId;const who=await target(c,message,arg);if(!who)throw new Error("无法识别目标，请回复消息或提供用户名/ID");if(sub==="sur"||sub==="obs"){const watch:Watch={targetId:who.id,targetName:who.name,triggerPeer:message.chatId,triggerMsgId:message.id,...(scope?{scopePeer:scope}:{})};watches.set(who.id,watch);await cfg(c).update(v=>({...normalizeConfig(v),surveillance:Object.fromEntries(watches)}));await c.telegram.edit(message,`${sub==="obs"?"正在定点监视":"正在蹲守"} ${who.name}`,{parseMode:"html"});return;}if(sub==="det"){let found:{peer:string;chat:Chat;msg:Cached}|undefined;for(const [peer,chat] of chats)for(const msg of chat.msgs)if(msg.senderId===who.id&&(!found||msg.date>found.msg.date))found={peer,chat,msg};await c.telegram.edit(message,found?`发现 ${who.name} 的最新消息：\n${link(found.peer,found.chat,found.msg)}`:`暂未发现 ${who.name} 的公开群消息`,{parseMode:"html",linkPreview:false});return;}if(sub==="loc"){let best:{peer:string;chat:Chat;count:number;msg?:Cached}|undefined;for(const [peer,chat] of chats){const items=chat.msgs.filter(x=>x.senderId===who.id);if(items.length&&(!best||items.length>best.count))best={peer,chat,count:items.length,msg:items[0]};}await c.telegram.edit(message,best?`${who.name} 最活跃的群组：${best.msg?link(best.peer,best.chat,best.msg):esc(best.chat.title??best.peer)}（${best.count} 条）`:`暂未定位到 ${who.name} 的活跃群组`,{parseMode:"html",linkPreview:false});return;}await c.telegram.edit(message,help(prefix),{parseMode:"html"});}catch(e){if(!c.signal.aborted)await c.telegram.edit(message,`操作失败：${esc(e instanceof Error?e.message:"未知错误")}`,{parseMode:"html"});}}}},listeners:[{edited:true,ignoreCommands:true,async handle(message,c){const raw:any=message.raw;if(!message.chatId)return;const peer=message.chatId;let chat=chats.get(peer);if(!chat){try{const entity:any=await c.telegram.withClient(client=>client.getEntity(raw?.peerId??returnBigInt(peer)));if(entity?.username)chat=chats.get(peer)??{username:String(entity.username),title:String(entity.title??entity.username),msgs:[]};}catch{}if(chat)chats.set(peer,chat);}if(chat){const observed=stripped(message);upsert(chat,observed);touch(peer,chat);if(rebuilding)recordIncrement(peer,observed);await schedule();}const watch=message.senderId?watches.get(message.senderId):undefined;if(!watch||watch.scopePeer&&watch.scopePeer!==peer||watch.triggerPeer===peer&&watch.triggerMsgId===message.id)return;let entity:any;try{entity=await c.telegram.withClient(client=>client.getEntity(raw?.peerId??returnBigInt(peer)));}catch{return;}if(!entity?.username)return;watches.delete(watch.targetId);await cfg(c).update(v=>({...normalizeConfig(v),surveillance:Object.fromEntries(watches)}));const current:Chat={username:String(entity.username),title:String(entity.title??entity.username),msgs:[stripped(message)]},result=`发现 ${watch.targetName} 最新动向：\n${link(peer,current,stripped(message))}`;await c.telegram.withClient(async client=>{await client.sendMessage(watch.triggerPeer,{message:result,parseMode:"html",linkPreview:false});await client.sendMessage("me",{message:result,parseMode:"html",linkPreview:false});});}}],settings:c=>({id:"fbi",title:"FBI 跨群追踪",description:"跨群公开消息缓存配置",category:"插件配置",icon:"🕵️",getSchema:()=>[{key:"cacheLimit",label:"缓存群组上限",type:"number",min:10,max:1000}],getValues:()=>cfg(c).read(),setValues:async patch=>{await applyLimit(normalizeConfig(await cfg(c).update(v=>normalizeConfig({...v,...patch}))));}}),async setup(c){context=c;await migrate(c);const state=normalizeConfig(await cfg(c).read()),saved=normalizeCache(await cacheStore(c).read());watches=new Map(Object.entries(state.surveillance));cacheLimit=state.cacheLimit;const restored=restore(saved.cache,cacheLimit);chats=restored.chats;activityClock=Math.max(0,...Array.from(chats.values(),activity));if(restored.changed)await persist();}});}
