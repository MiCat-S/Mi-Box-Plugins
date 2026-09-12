import {mathQuestion, textQuestion, answerMatches} from "./v2/questions";
import {generateImageCaptcha as imageCaptcha} from "./v2/image";
import {setTimeout as sleep} from "node:timers/promises";
import {readFile} from "node:fs/promises";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, type CommandInvocation, type SubcommandDefinition, definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {returnBigInt} from "teleproto/Helpers";

type Mode="math"|"text"|"img_digit"|"img_mixed";type Premium="allow"|"ban"|"only"|"none";type Fail="block"|"delete"|"report"|"mute"|"archive";type Pass="unmute"|"unarchive"|"whitelist";
type RecordEntry={id:string;name:string;username?:string;time:string;reason?:string};
type Config={enabled:boolean;captchaEnabled:boolean;mode:Mode;timeout:number;maxTries:number;keyword:string;prompt:string;failActions:Fail[];passActions:Pass[];whitelist:string[];verified:RecordEntry[];failed:RecordEntry[];initiative:boolean;historyCount:number;groupsInCommon:number;wlWords:string[];blWords:string[];premium:Premium};
type Session={userId:string;answer:string;question:string;tries:number;deadline:number;mode:Mode;promptIds:number[];createdAt:number;isQA?:boolean};
type State={schemaVersion:1;config:Config;sessions:Record<string,Session>;importedLegacy:boolean;[key:string]:unknown};
const failAliases: Readonly<Record<string, Fail>> = {block: "block", 屏蔽: "block", delete: "delete", 删除: "delete", report: "report", 举报: "report", mute: "mute", 静音: "mute", archive: "archive", 归档: "archive"};
const passAliases: Readonly<Record<string, Pass>> = {unmute: "unmute", 取消静音: "unmute", 解除静音: "unmute", unarchive: "unarchive", 取消归档: "unarchive", whitelist: "whitelist", 白名单: "whitelist"};
function actions<T extends string>(values: readonly string[], aliases: Readonly<Record<string, T>>): T[] {
  if (values.length === 1 && ["无", "none"].includes(values[0].toLowerCase())) return [];
  return [...new Set(values.map(value => {
    const action = Object.hasOwn(aliases, value.toLowerCase()) ? aliases[value.toLowerCase()] : undefined;
    if (!action) throw new Error("未知动作，请使用帮助中的动作名称");
    return action;
  }))];
}
const config:Config={enabled:true,captchaEnabled:false,mode:"math",timeout:30,maxTries:3,keyword:"我同意",prompt:"",failActions:[],passActions:[],whitelist:[],verified:[],failed:[],initiative:true,historyCount:-1,groupsInCommon:-1,wlWords:[],blWords:[],premium:"none"};
const defaults:State={schemaVersion:1,config,sessions:{},importedLegacy:false};
const store=(ctx:PluginContext)=>ctx.storage.json<State>("state.json",defaults);
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[c]!);
const error=(e:unknown)=>e instanceof Error?e.message:String(e);
const validMode=(v:unknown):v is Mode=>["math","text","img_digit","img_mixed"].includes(String(v));
const bounded=(value:unknown,min:number,max:number,fallback:number)=>{const parsed=Number(value);return Number.isSafeInteger(parsed)&&parsed>=min&&parsed<=max?parsed:fallback;};
const strings=(value:unknown,limit:number)=>Array.isArray(value)?value.map(String).map(item=>item.slice(0,240)).slice(-limit):[];
const normalizeRecords=(value:unknown):RecordEntry[]=>(Array.isArray(value)?value:[]).flatMap((item:any)=>{
  const id=String(item?.id??"").slice(0,80);if(!/^\d+$/.test(id))return[];
  return[{id,name:String(item?.name??id).slice(0,160),...(item?.username?{username:String(item.username).slice(0,80)}:{}),time:String(item?.time??"").slice(0,80),...(item?.reason?{reason:String(item.reason).slice(0,240)}:{})}];
}).slice(-1000);
function normalize(current:any):State{const c=current?.config??current??{},failActions=Array.isArray(c.failActions)?c.failActions:[],passActions=Array.isArray(c.passActions)?c.passActions:[];return{...current,schemaVersion:1,config:{...config,...c,enabled:typeof c.enabled==="boolean"?c.enabled:config.enabled,captchaEnabled:typeof c.captchaEnabled==="boolean"?c.captchaEnabled:config.captchaEnabled,initiative:typeof c.initiative==="boolean"?c.initiative:config.initiative,mode:validMode(c.mode)?c.mode:"math",premium:["allow","ban","only","none"].includes(c.premium)?c.premium:"none",timeout:bounded(c.timeout,0,3600,config.timeout),maxTries:bounded(c.maxTries??c.tries,0,20,config.maxTries),historyCount:bounded(c.historyCount,-1,1000,config.historyCount),groupsInCommon:bounded(c.groupsInCommon,-1,1000,config.groupsInCommon),keyword:String(c.keyword??config.keyword).slice(0,240),prompt:String(c.prompt??config.prompt).slice(0,2000),whitelist:strings(c.whitelist,1000).filter(id=>/^\d{1,80}$/.test(id)),verified:normalizeRecords(c.verified),failed:normalizeRecords(c.failed),failActions:[...new Set(failActions.filter((x:any)=>["block","delete","report","mute","archive"].includes(x)))].slice(0,5),passActions:[...new Set(passActions.filter((x:any)=>["unmute","unarchive","whitelist"].includes(x)))].slice(0,3),wlWords:strings(c.wlWords,100),blWords:strings(c.blWords,100)},sessions:Object.fromEntries(Object.entries(current?.sessions&&typeof current.sessions==="object"?current.sessions:{}).slice(-1000).flatMap(([id,v]:[string,any])=>/^\d{1,80}$/.test(id)&&v?.answer&&Number.isSafeInteger(Number(v.deadline))&&Number(v.deadline)>0?[[String(id),{userId:String(v.userId??id).slice(0,80),answer:String(v.answer).slice(0,240),question:String(v.question??"").slice(0,2000),tries:bounded(v.tries,0,20,0),deadline:Number(v.deadline),mode:validMode(v.mode)?v.mode:"math",promptIds:(Array.isArray(v.promptIds)?v.promptIds:[]).map(Number).filter(Number.isSafeInteger).slice(-10),createdAt:Number.isSafeInteger(Number(v.createdAt))?Number(v.createdAt):Date.now(),...(typeof v.isQA==="boolean"?{isQA:v.isQA}:{})}]]:[])),importedLegacy:true};}
async function migrate(ctx:PluginContext){const state=await store(ctx).read();if(state.importedLegacy&&state.schemaVersion===1)return;let legacyConfig:any={},legacyData:any={};try{legacyConfig=JSON.parse(await readFile(ctx.files.dataPath("pmcaptcha_config.json"),"utf8"));}catch{}try{legacyData=JSON.parse(await readFile(ctx.files.dataPath("pmcaptcha_data.json"),"utf8"));}catch{}const mapped={enabled:legacyConfig.plugin_enabled,captchaEnabled:legacyConfig.captcha_enabled,mode:legacyConfig.captcha_mode,timeout:legacyConfig.captcha_timeout,maxTries:legacyConfig.captcha_max_tries,keyword:legacyConfig.captcha_text_keyword,prompt:legacyConfig.captcha_prompt,failActions:legacyConfig.captcha_fail_actions,passActions:legacyConfig.captcha_pass_actions,initiative:legacyConfig.auto_initiative,historyCount:legacyConfig.auto_history_count,groupsInCommon:legacyConfig.auto_groups_in_common,wlWords:legacyConfig.auto_whitelist_words,blWords:legacyConfig.auto_blacklist_words,premium:legacyConfig.auto_premium,whitelist:legacyData.whitelist_user_ids,verified:legacyData.verified_users,failed:legacyData.failed_users};const defined=Object.fromEntries(Object.entries(mapped).filter(([,v])=>v!==undefined));await store(ctx).update(v=>normalize({...v,config:{...v.config,...defined},importedLegacy:true}));}
function sender(m:MessageEnvelope){const raw=m.raw as any,s=raw?.sender??raw?._sender;return{name:String([s?.firstName,s?.lastName].filter(Boolean).join(" ")||s?.username||m.senderId||"用户"),...(s?.username?{username:String(s.username)}:{}),bot:!!s?.bot,premium:!!s?.premium};}
function prompt(c:Config,s:Session){const footer=`\n\n⏱ 验证时间：<b>${c.timeout||"不限"}</b> 秒\n🔢 最大次数：<b>${c.maxTries||"不限"}</b>`;if(s.mode==="text")return s.isQA?`🔒 <b>人机验证</b>\n\n请回答以下问题：\n\n<b>${esc(s.question)}</b>${footer}`:c.prompt?esc(c.prompt).replace("{keyword}",esc(s.question)):`🔒 <b>人机验证</b>\n\n请回复：<code>${esc(s.question)}</code>${footer}`;return c.prompt?esc(c.prompt).replace("{question}",esc(s.question)):`🔒 <b>人机验证</b>\n\n请回答：<code>${esc(s.question)} = ?</code>${footer}`;}
async function peer(ctx:PluginContext,userId:string){return ctx.telegram.withClient(client=>client.getInputEntity(returnBigInt(userId)));}
async function cleanupMessages(ctx:PluginContext,s:Session){if(!s.promptIds.length)return;await ctx.telegram.withClient(async client=>client.deleteMessages(returnBigInt(s.userId),s.promptIds,{revoke:false})).catch(()=>{});}
async function notifySettings(ctx:PluginContext,userId:string,mute:boolean){await ctx.telegram.withClient(async client=>{const peer=await client.getInputEntity(returnBigInt(userId));await client.updateNotifySettings(peer,{muteUntil:mute?2_147_483_647:0,silent:mute,showPreviews:true});});}
async function archive(ctx:PluginContext,userId:string,folderId:number){await ctx.telegram.withClient(async client=>{const {Api}=await import("teleproto");await client.invoke(new Api.folders.EditPeerFolders({folderPeers:[new Api.InputFolderPeer({peer:await client.getInputEntity(returnBigInt(userId)),folderId})]}));});}
async function fail(ctx:PluginContext,userId:string,c:Config){await archive(ctx,userId,1).catch(()=>{});await notifySettings(ctx,userId,true).catch(()=>{});for(const action of c.failActions){ctx.signal.throwIfAborted();await ctx.telegram.withClient(async client=>{const {Api}=await import("teleproto");const p=await client.getInputEntity(returnBigInt(userId));if(action==="block")await client.invoke(new Api.contacts.Block({id:p}));else if(action==="delete")await client.invoke(new Api.messages.DeleteHistory({peer:p,maxId:0,revoke:true}));else if(action==="report")await client.invoke(new Api.account.ReportPeer({peer:p,reason:new Api.InputReportReasonSpam(),message:""}));}).catch(()=>{});}}
async function pass(ctx:PluginContext,userId:string,c:Config,cancel:()=>void=()=>{}){await store(ctx).update(v=>{const sessions={...v.sessions};delete sessions[userId];const now=new Date().toISOString();const entry:RecordEntry={id:userId,name:userId,time:now};return{...v,config:{...v.config,whitelist:c.passActions.includes("whitelist")?[...new Set([...v.config.whitelist,userId])].slice(-1000):v.config.whitelist,verified:[...v.config.verified.filter(x=>x.id!==userId),entry].slice(-1000),failed:v.config.failed.filter(x=>x.id!==userId)},sessions};});cancel();for(const action of c.passActions){if(action==="unmute")await notifySettings(ctx,userId,false).catch(()=>{});else if(action==="unarchive")await archive(ctx,userId,0).catch(()=>{});}}
async function timeout(ctx:PluginContext,userId:string,deadline:number,cancelSignal:AbortSignal){const delay=Math.max(0,deadline-Date.now());await ctx.tasks.run(`pmcaptcha:timeout:${userId}:${deadline}`,async scoped=>{const signal=AbortSignal.any([scoped,cancelSignal]);await sleep(delay,undefined,{signal});let session:Session|undefined,c!:Config;await store(ctx).update(v=>{session=v.sessions[userId];c=v.config;if(!session||session.deadline!==deadline)return v;const sessions={...v.sessions};delete sessions[userId];const info:RecordEntry={id:userId,name:userId,time:new Date().toISOString(),reason:"timeout"};return{...v,config:{...v.config,failed:[...v.config.failed.filter(x=>x.id!==userId),info].slice(-1000)},sessions};});if(session){await cleanupMessages(ctx,session);await fail(ctx,userId,c);}});}
async function start(ctx:PluginContext,userId:string,c:Config,schedule:(userId:string,deadline:number)=>void){const isQA=c.mode==="text"&&c.keyword==="我同意"&&!c.prompt;let q=c.mode==="text"?(isQA?textQuestion():{question:c.keyword,answer:c.keyword}):mathQuestion(),effective:Mode=c.mode,image:Buffer|undefined;if(c.mode.startsWith("img_")){const generated=await imageCaptcha(c.mode==="img_digit");if(generated){q={question:generated.answer,answer:generated.answer};image=generated.buffer;}else effective="math";}const s:Session={userId,answer:q.answer,question:q.question,tries:0,deadline:c.timeout?Date.now()+c.timeout*1000:Number.MAX_SAFE_INTEGER,mode:effective,promptIds:[],createdAt:Date.now(),isQA};const sent=await ctx.telegram.withClient(async client=>{if(image){const {CustomFile}=await import("teleproto/client/uploads.js");return client.sendMessage(returnBigInt(userId),{message:c.prompt?c.prompt:`🔒 人机验证\n\n请输入图片中的 5 位${c.mode==="img_digit"?"数字":"大写字母或数字"}验证码`,file:new CustomFile("captcha.png",image.length,"",image)});}return client.sendMessage(returnBigInt(userId),{message:effective!==c.mode?`🔒 <b>人机验证</b>（图片组件不可用，已切换为算术验证）\n\n请回答：<code>${esc(q.question)} = ?</code>`:prompt(c,s),parseMode:"html"});});s.promptIds=[sent.id];await store(ctx).update(v=>({...v,sessions:{...v.sessions,[userId]:s}}));if(c.timeout)schedule(userId,s.deadline);}
async function autoRule(ctx:PluginContext,m:MessageEnvelope,c:Config,info:ReturnType<typeof sender>):Promise<"pass"|"block"|"skip">{if(c.historyCount>0){const count=await ctx.telegram.withClient(async client=>(await client.getMessages(returnBigInt(m.senderId!),{limit:c.historyCount+1})).filter((x:any)=>x.id!==m.id).length).catch(()=>0);if(count>=c.historyCount)return"pass";}if(c.groupsInCommon>=0){const count=await ctx.telegram.withClient(async client=>{const {Api}=await import("teleproto");const x:any=await client.invoke(new Api.users.GetFullUser({id:await client.getInputEntity(returnBigInt(m.senderId!))}));return Number(x?.fullUser?.commonChatsCount??-1);}).catch(()=>-1);if(count>=c.groupsInCommon)return"pass";}if(c.wlWords.some(w=>m.text.includes(w)))return"pass";if(c.blWords.some(w=>m.text.includes(w)))return"block";let premium=info.premium;
if(c.premium!=="none"&&!(m.raw as any)?.sender&&!(m.raw as any)?._sender){
  try{premium=await ctx.telegram.withClient(async client=>{const {Api}=await import("teleproto");const full:any=await client.invoke(new Api.users.GetFullUser({id:await client.getInputEntity(returnBigInt(m.senderId!))}));return !!full?.users?.[0]?.premium;});}
  catch{ctx.signal.throwIfAborted();return "skip";}
}
if(c.premium==="allow"&&premium)return"pass";if(c.premium==="ban"&&premium)return"block";if(c.premium==="only")return premium?"pass":"block";return"skip";}
async function resolve(ctx:PluginContext,message:MessageEnvelope,arg?:string){if(message.replyToId){const reply=await ctx.telegram.getReply(message);if(reply?.senderId)return reply.senderId;}if(!arg)throw new Error("请提供用户 ID/用户名或回复消息");return ctx.telegram.withClient(async client=>String((await client.getEntity(/^\d+$/.test(arg)?returnBigInt(arg):arg) as any).id));}

function create(){
  const processing=new Set<string>(),timeouts=new Map<string,AbortController>();
  const cancel=(userId:string)=>{const current=timeouts.get(userId);if(current&&!current.signal.aborted)current.abort(new DOMException("Captcha completed","AbortError"));timeouts.delete(userId);};
  const schedule=(ctx:PluginContext,userId:string,deadline:number)=>{cancel(userId);const controller=new AbortController();timeouts.set(userId,controller);void timeout(ctx,userId,deadline,controller.signal).catch(e=>{if(!ctx.signal.aborted&&!controller.signal.aborted)ctx.log.error("pmcaptcha:timeout",{userId,error:error(e).slice(0,200)});}).finally(()=>{if(timeouts.get(userId)===controller)timeouts.delete(userId);});};
  const {command,help}=makeCommand(cancel);
  return definePlugin({renderHelp:help,apiVersion:STRUCTURED_PLUGIN_API_VERSION,id:"pmcaptcha",description:"陌生人私聊验证码与自动过白规则",commands:{pmc:command,pmcaptcha:command},listeners:[{chats:["private"],edited:false,ignoreCommands:false,async handle(message,ctx){if(!message.senderId||message.senderId==="777000")return;const state=await store(ctx).read(),c=state.config;if(!c.enabled)return;if(message.outgoing){if(c.initiative&&!state.sessions[message.chatId])await store(ctx).update(v=>({...v,config:{...v.config,whitelist:[...new Set([...v.config.whitelist,message.chatId])].slice(-1000)}}));return;}if(processing.has(message.senderId))return;processing.add(message.senderId);try{const info=sender(message);if(info.bot||c.whitelist.includes(message.senderId)||c.verified.some(x=>x.id===message.senderId))return;const session=state.sessions[message.senderId];if(session){const input=message.text.trim();if(!input)return;if(answerMatches(input,session.answer,session.mode==="img_digit"||session.mode==="img_mixed")){await pass(ctx,message.senderId,c,()=>cancel(message.senderId!));await cleanupMessages(ctx,session);await ctx.telegram.reply(message,"✅ 验证通过");return;}let exhausted=false;await store(ctx).update(v=>{const s=v.sessions[message.senderId!];if(!s)return v;const tries=s.tries+1;exhausted=c.maxTries>0&&tries>=c.maxTries;if(exhausted){const sessions={...v.sessions};delete sessions[message.senderId!];return{...v,sessions,config:{...v.config,failed:[...v.config.failed.filter(x=>x.id!==message.senderId),{id:message.senderId!,name:info.name,...(info.username?{username:info.username}:{}),time:new Date().toISOString(),reason:"max_tries"}].slice(-1000)}};}return{...v,sessions:{...v.sessions,[message.senderId!]:{...s,tries}}};});if(exhausted){cancel(message.senderId);await cleanupMessages(ctx,session);await fail(ctx,message.senderId,c);}else await ctx.telegram.reply(message,"❌ 答案不正确，请重试");return;}const rule=await autoRule(ctx,message,c,info);if(rule==="pass"){await pass(ctx,message.senderId,c,()=>cancel(message.senderId!));return;}if(rule==="block"){cancel(message.senderId);await fail(ctx,message.senderId,c);return;}await archive(ctx,message.senderId,1).catch(()=>{});await notifySettings(ctx,message.senderId,true).catch(()=>{});if(c.captchaEnabled)await start(ctx,message.senderId,c,(id,deadline)=>schedule(ctx,id,deadline));}finally{processing.delete(message.senderId);}}}],settings:ctx=>({id:"pmcaptcha",title:"私聊验证码",description:"私聊验证开关与规则",category:"插件配置",icon:"🔒",getSchema:()=>[{key:"enabled",label:"启用",type:"boolean"},{key:"captchaEnabled",label:"启用验证码",type:"boolean"},{key:"mode",label:"验证模式",type:"select",options:[{value:"math",label:"算术"},{value:"text",label:"文字"},{value:"img_digit",label:"图片数字（降级算术）"},{value:"img_mixed",label:"图片混合（降级算术）"}]},{key:"timeout",label:"超时秒数",type:"number",min:0,max:3600},{key:"maxTries",label:"最大尝试",type:"number",min:0,max:20},{key:"keyword",label:"文字关键词",type:"string"}],getValues:async()=>({...((await store(ctx).read()).config)}),setValues:async patch=>{await store(ctx).update(v=>normalize({...v,config:{...v.config,...patch}}));}}),async setup(ctx){await migrate(ctx);const current=await store(ctx).update(normalize);for(const s of Object.values(current.sessions))if(s.deadline<Number.MAX_SAFE_INTEGER)schedule(ctx,s.userId,s.deadline);},cleanup(){processing.clear();for(const id of [...timeouts.keys()])cancel(id);}});
}

const guarded = (operation: (i: CommandInvocation, ctx: PluginContext, state: State) => Promise<void>): CommandDefinition["handle"] => async (i, ctx) => {
  try { await operation(i, ctx, await store(ctx).read()); }
  catch(e) { if (!ctx.signal.aborted) await ctx.telegram.edit(i.message, `操作失败：<code>${esc(error(e))}</code>`, {parseMode: "html"}); }
};
const enabled = (value: boolean): SubcommandDefinition => ({description: value ? "启用私聊规则" : "停用私聊规则，保留配置", args: "", handle: guarded(async (i, ctx) => {
  await store(ctx).update(v => normalize({...v, config: {...v.config, enabled: value}}));
  await ctx.telegram.edit(i.message, value ? "私聊验证码已启用" : "私聊验证码已停用");
})});
const captcha = (patch: Partial<Config>): CommandDefinition["handle"] => guarded(async (i, ctx) => {
  await store(ctx).update(v => normalize({...v, config: {...v.config, ...patch}}));
  await ctx.telegram.edit(i.message, "验证码设置已更新。");
});
const setting = (update: (c: Config, values: readonly string[]) => void): CommandDefinition["handle"] => guarded(async (i, ctx) => {
  await store(ctx).update(v => { const next = {...v.config}; update(next, i.args); return normalize({...v, config: next}); });
  await ctx.telegram.edit(i.message, "设置已更新。");
});
const whitelist = (operation: "add" | "del" | "pass", nested: boolean, cancelById: (id:string)=>void): CommandDefinition["handle"] => guarded(async (i, ctx) => {
  const id = await resolve(ctx, i.message, i.args[0]);
  await store(ctx).update(v => {
    const sessions = {...v.sessions}; if (operation === "pass") delete sessions[id];
    return {...v, ...(nested ? {sessions} : {}), config: {...v.config, whitelist: operation === "del" ? v.config.whitelist.filter(x => x !== id) : [...new Set([...v.config.whitelist, id])].slice(-1000)}};
  });
  if(operation==="pass")cancelById(id);
  await ctx.telegram.edit(i.message, nested ? "白名单已更新。" : operation === "add" ? "已加入白名单" : "已移出白名单");
});
async function deliver(ctx:PluginContext,message:MessageEnvelope,lines:readonly string[],html=false){const pages:string[]=[];let page="";for(const line of lines.length?lines:["记录为空"]){if(page&&page.length+line.length+1>3500){pages.push(page);page="";}page+=`${page?"\n":""}${line}`;}if(page)pages.push(page);for(const[index,value]of pages.entries()){if(index)await ctx.telegram.reply(message,value,html?{parseMode:"html"}:{});else await ctx.telegram.edit(message,value,html?{parseMode:"html"}:{});}}
const records = (which: "failed" | "verified"): CommandDefinition["handle"] => guarded(async (i, ctx, state) => {
  const list = state.config[which];
  await deliver(ctx,i.message,list.map(x => `<code>${esc(x.id)}</code> ${esc(x.name)} ${esc(x.reason ?? "")}`),true);
});
function makeCommand(cancelById:(id:string)=>void):{command:CommandDefinition;help:(prefix:string)=>string}{
let help!:(prefix:string)=>string;
const command: CommandDefinition = {
  helpOnEmpty: true, helpArgs: ["h", "help"], description: "配置私聊验证码与自动过白规则", subcommandsCaseSensitive: false,
  subcommands: {
    on: enabled(true), off: enabled(false),
    status: {description: "查看启用状态、验证码模式、白名单及待验证人数", args: "", handle: guarded(async (i, ctx, state) => {
      const c = state.config;
      await ctx.telegram.edit(i.message, `状态：${c.enabled ? "启用" : "停用"}\n验证码：${c.captchaEnabled ? "启用" : "停用"}\n模式：<code>${c.mode}</code>\n白名单：${c.whitelist.length}\n待验证：${Object.keys(state.sessions).length}`, {parseMode: "html"});
    })},
    captcha: {description: "设置验证码开关与模式", subcommands: {
      on: {description: "开启验证码", args: "", handle: captcha({captchaEnabled: true})},
      off: {description: "关闭验证码", args: "", handle: captcha({captchaEnabled: false})},
      math: {description: "随机算术验证（默认），无需额外依赖", args: "", handle: captcha({mode: "math"})},
      text: {description: "文字验证", args: "", help: [{heading: "文字模式：", body: "默认关键词为“我同意”且未自定义提示时使用随机问答；修改 keyword 或 prompt 后按指定关键词验证。"}], handle: captcha({mode: "text"})},
      img_digit: {description: "5 位数字图片验证码", args: "", handle: captcha({mode: "img_digit"})},
      img_mixed: {description: "5 位大写字母与数字图片验证码", args: "", handle: captcha({mode: "img_mixed"})},
    }, help: [{heading: "图片依赖：", body: "缺少 canvas 等图片组件时自动降级为算术验证并在提示中说明。"}], handle: captcha({})},
    set: {description: "设置验证参数和自动规则", subcommands: {
      time: {description: "验证超时秒数，默认 30，0 表示不限时", args: "秒", handle: setting((c, v) => { const value=Number(v[0]);if(!Number.isSafeInteger(value)||value<0||value>3600)throw new Error("超时必须是 0-3600 的整数");c.timeout=value; })},
      tries: {description: "最大尝试次数，默认 3，0 表示不限", args: "次数", handle: setting((c, v) => { const value=Number(v[0]);if(!Number.isSafeInteger(value)||value<0||value>20)throw new Error("次数必须是 0-20 的整数");c.maxTries=value; })},
      keyword: {description: "设置文字模式关键词，省略恢复“我同意”", args: "[关键词]", handle: setting((c, v) => { c.keyword = v.join(" ") || config.keyword; })},
      prompt: {description: "设置自定义提示，留空恢复默认", args: "[文本]", help: [{heading: "占位符：", body: "math 模式使用 {question} 表示题目；text 模式使用 {keyword} 表示关键词。"}], handle: setting((c, v) => { c.prompt = v.join(" "); })},
      initiative: {description: "我方主动私聊时自动加入白名单，默认开启", args: "on|off", help:[{heading:"兼容性：",body:"仅小写 on 开启；其他非空值按旧版语义关闭。"}],handle: setting((c, v) => { if(!v[0])throw new Error("请使用 on 或 off");c.initiative = v[0] === "on"; })},
      history: {description: "按历史消息数量自动通过，正数启用，-1 禁用", args: "N", handle: setting((c, v) => { const value=Number(v[0]);if(!Number.isSafeInteger(value)||value< -1||value>1000)throw new Error("历史数量必须是 -1 到 1000 的整数");c.historyCount=value; })},
      groups: {description: "按共同群数量自动通过，-1 禁用", args: "N", handle: setting((c, v) => { const value=Number(v[0]);if(!Number.isSafeInteger(value)||value< -1||value>1000)throw new Error("共同群数量必须是 -1 到 1000 的整数");c.groupsInCommon=value; })},
      "wl-words": {description: "设置白名单关键词", args: "词1 [词2...]|none", handle: setting((c, v) => { c.wlWords = v.includes("none") ? [] : [...v]; })},
      "bl-words": {description: "设置黑名单关键词", args: "词1 [词2...]|none", handle: setting((c, v) => { c.blWords = v.includes("none") ? [] : [...v]; })},
      premium: {description: "设置 Premium 规则", args: "allow|ban|only|none", help: [{heading: "策略：", body: "allow 允许 Premium 用户；ban 拦截 Premium 用户；only 只允许 Premium 用户；none 禁用该规则（默认）。"}], handle: setting((c, v) => {
        if (!["allow", "ban", "only", "none"].includes(v[0])) throw new Error("未知设置项"); c.premium = v[0] as Premium;
      })},
      fail: {description: "设置失败后动作，空格分隔多选", args: "动作 [...]", examples: [{args: "fail 屏蔽 举报"}], help: [{heading: "动作：", body: "屏蔽/block、删除/delete、举报/report、静音/mute、归档/archive；无/none 清空。陌生会话和验证失败时会先静音并归档，再执行其他配置动作。"}], handle: setting((c, v) => { c.failActions = actions(v, failAliases); })},
      pass: {description: "设置通过后动作，空格分隔多选", args: "动作 [...]", help: [{heading: "动作：", body: "取消静音（解除静音）/unmute、取消归档/unarchive、白名单/whitelist；无/none 清空。设置用于后续验证处理。"}], handle: setting((c, v) => { c.passActions = actions(v, passAliases); })},
    }, handle: setting(() => { throw new Error("未知设置项"); })},
    add: {description: "添加白名单", args: "[ID或@用户名]", help: [{heading: "目标：", body: "回复用户消息时优先使用被回复发送者，可省略参数。"}], handle: whitelist("add", false,cancelById)},
    del: {description: "移除白名单", args: "[ID或@用户名]", handle: whitelist("del", false,cancelById)},
    wl: {description: "查看或管理白名单", aliases: ["whitelist"], args: "", subcommands: {
      add: {description: "添加用户，回复消息时可省略目标", args: "[ID或@用户名]", handle: whitelist("add", true,cancelById)},
      del: {description: "移除用户，回复消息时可省略目标", args: "[ID或@用户名]", subcommands: {
        all: {caseSensitive: true, description: "清空白名单", args: "", handle: guarded(async (i, ctx) => { await store(ctx).update(v => ({...v, config: {...v.config, whitelist: []}})); await ctx.telegram.edit(i.message, "白名单已清空"); })},
      }, handle: whitelist("del", true,cancelById)},
      pass: {description: "结束该用户待验证会话并加入白名单", args: "[ID或@用户名]", handle: whitelist("pass", true,cancelById)},
    }, handle: guarded(async (i, ctx, state) => {
      if (!i.args[0]) { const c = state.config; await deliver(ctx,i.message,c.whitelist.map(id => `<code>${esc(id)}</code>`),true); return; }
      const id = await resolve(ctx, i.message, i.args[1]);
      await store(ctx).update(v => ({...v, sessions: {...v.sessions}, config: {...v.config, whitelist: [...new Set([...v.config.whitelist, id])].slice(-1000)}}));
      await ctx.telegram.edit(i.message, "白名单已更新。");
    })},
    record: {description: "查看验证记录摘要", args: "", subcommandsCaseSensitive: true, subcommands: {
      verified: {description: "查看通过记录", args: "", handle: records("verified")},
      failed: {description: "查看失败记录", args: "", handle: records("failed")},
    }, handle: guarded(async (i, ctx, state) => { await ctx.telegram.edit(i.message, `通过：${state.config.verified.length}\n失败：${state.config.failed.length}`); })},
  },
  examples: [{args: "on"}, {args: "captcha on"}, {args: "captcha math"}, {args: "set fail 屏蔽", description: "按顺序启用插件、验证码、模式和失败动作"}],
  help: [{heading: "自动规则与顺序：", body: "我方主动私聊可自动加入白名单；收到陌生人私聊时，依次检查历史消息数、共同群数、白名单词、黑名单词、Premium 策略，命中即处理。规则未命中时先静音并归档，验证码开启时再发送验证题。插件默认启用、验证码默认关闭。"},
    {heading: "命令别名：", body: "<code>{prefix}pmcaptcha</code> 与 <code>{prefix}pmc</code> 使用相同参数。"}],
  handle: guarded(async (i, ctx) => {
    const sub = i.args[0]?.toLowerCase();
    if (!sub || sub === "h" || sub === "help") { await ctx.telegram.edit(i.message, help(i.prefix), {parseMode: "html"}); return; }
    throw new Error("未知命令");
  }),
};
help = (prefix: string) => renderCommandHelp("pmc", command, {prefix, title: "🔒 PMCaptcha 私聊验证码"});
return{command,help};
}

export default create;
