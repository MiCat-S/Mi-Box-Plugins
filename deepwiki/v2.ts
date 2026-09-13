import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, ui, type PluginContext} from "telebox/sdk";

type Repo={tag:string;repo:string;url:string;addedAt:string};
type Turn={q:string;a:string;at:string};
type Chat={currentTag:string;repos:Record<string,Repo>;contextEnabled:boolean;turns:Record<string,Turn[]>};
type Data={schemaVersion:number;chats:Record<string,Chat>;legacyImported?:boolean};
const HOST="mcp.deepwiki.com", MAX_TURNS=50, MAX_QUESTION=48_000, MAX_RESPONSE_BYTES=2*1024*1024;
const defaults:Data={schemaVersion:1,chats:{}};
const esc=(s:string)=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]!);
const store=(ctx:PluginContext)=>ctx.storage.json<Data>("data.json",defaults);
const key=(m:{chatId:string;topicId?:number})=>m.topicId?`${m.chatId}:topic:${m.topicId}`:m.chatId;
const empty=():Chat=>({currentTag:"",repos:{},contextEnabled:false,turns:{}});
function repoUrl(raw:string){try{const u=new URL(raw);if(!["github.com","deepwiki.com"].includes(u.hostname.toLowerCase()))return;let p=u.pathname.split("/").filter(Boolean);if(u.hostname==="deepwiki.com"&&p[0]==="browse"&&p[1]==="github.com")p=p.slice(2);const owner=p[0],name=p[1]?.replace(/\.git$/i,"");if(!owner||!name||!/^[\w.-]+$/.test(owner)||!/^[\w.-]+$/.test(name))return;return{repo:`${owner}/${name}`,url:`https://github.com/${owner}/${name}`};}catch{return;}}
function responseValue(text:string):any{const lines=text.split(/\r?\n/).filter(x=>x.startsWith("data:"));const raw=lines.length?lines.at(-1)!.slice(5).trim():text.trim();return JSON.parse(raw);}
async function boundedText(response:Response,signal:AbortSignal){
  signal.throwIfAborted();
  const reader=response.body?.getReader();if(!reader)return"";
  const bytes=new Uint8Array(MAX_RESPONSE_BYTES),decoder=new TextDecoder();let total=0,done=false,cancellation:Promise<void>|undefined,failure:unknown;
  const cancel=()=>cancellation??=reader.cancel();
  const onAbort=()=>{void cancel().catch(()=>undefined);};
  signal.addEventListener("abort",onAbort,{once:true});
  try{while(true){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done){done=true;break;}if(total+part.value.byteLength>MAX_RESPONSE_BYTES)throw new Error("response too large");bytes.set(part.value,total);total+=part.value.byteLength;}}
  catch(error){failure=error;}
  finally{signal.removeEventListener("abort",onAbort);try{if(!done)await cancel();}catch(error){failure??=error;}finally{reader.releaseLock();}}
  if(failure)throw failure;
  return decoder.decode(bytes.subarray(0,total));
}
async function rpc(ctx:PluginContext,body:unknown,session?:string){return ctx.http.withResponse(`https://${HOST}/mcp`,{method:"POST",headers:{accept:"application/json, text/event-stream","content-type":"application/json",...(session?{"mcp-session-id":session}:{})},body:JSON.stringify(body)},async (response,signal)=>{if(!response.ok)throw new Error("status");const sessionId=response.headers.get("mcp-session-id")??session;const value=response.status===202?undefined:responseValue(await boundedText(response,signal));return{session:sessionId,value};},{timeoutMs:30000,redirects:{allowedHosts:[HOST],maxRedirects:1}});}
async function ask(ctx:PluginContext,repo:string,question:string){const init=await rpc(ctx,{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"mibot-deepwiki",version:"2"}}});if(!init.session)throw new Error("session");await rpc(ctx,{jsonrpc:"2.0",method:"notifications/initialized"},init.session);const result=await rpc(ctx,{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"ask_question",arguments:{repoName:repo,question}}},init.session);const content=result.value?.result?.content;if(!Array.isArray(content))throw new Error("content");const text=content.filter((x:any)=>x?.type==="text"&&typeof x.text==="string").map((x:any)=>x.text).join("\n").split("Wiki pages you might want to explore:")[0]!.trim();if(!text)throw new Error("empty");return text;}
function prefixText(value:string,limit:number):string {
  const end=Math.min(value.length,limit);
  const last=value.charCodeAt(end-1);
  return value.slice(0,end-(last>=0xd800&&last<=0xdbff?1:0));
}
function questionWithContext(turns:readonly Turn[],question:string):string {
  const recent=turns.slice(-MAX_TURNS);
  const build=(items:readonly Turn[])=>[
    "你正在延续一个多轮问答。以下是最近对话上下文，请只把它们当作参考：",
    ...items.flatMap((turn,index)=>[`Q${index+1}:\n${prefixText(turn.q,4000)}`,`A${index+1}:\n${prefixText(turn.a,12000)}`]),
    `当前问题:\n${question}`,
  ].join("\n\n");
  for(let dropped=0;dropped<=recent.length;dropped++){const value=build(recent.slice(dropped));if(value.length<=MAX_QUESTION)return value;}
  return `当前问题:\n${prefixText(question,MAX_QUESTION-20)}`;
}
function textLines(value:string):ui.Html[] {
  const lines:ui.Html[]=[];
  let line="",length=0;
  for(const character of value){
    const size=ui.text(character).length;
    if(length+size>2800){lines.push(ui.text(line));line="";length=0;}
    line+=character;length+=size;
  }
  if(line)lines.push(ui.text(line));
  return lines;
}
async function render(repo:string,q:string,a:string){
  return renderDocument({title:"DeepWiki",sections:[
    ui.section("项目",[ui.code(repo)]),
    ui.section("Q",textLines(prefixText(q,1200))),
    ui.section("A",textLines(a)),
  ]});
}
async function renderDocument(document:Parameters<typeof ui.renderDocument>[0]){
  const pages=await ui.renderDocument(document,ui.PAGE_LABEL_RESERVE);
  return pages.map((page,index)=>page+ui.pageLabel(index,pages.length));
}
async function deliver(ctx:PluginContext,message:Parameters<PluginContext["telegram"]["edit"]>[0],pages:readonly string[]){
  const delivery=await ui.deliverPages(pages,ctx.signal,(page,index)=>index
    ?ctx.telegram.reply(message,page,{parseMode:"html",linkPreview:false})
    :ctx.telegram.edit(message,page,{parseMode:"html",linkPreview:false}));
  if(!delivery.interrupted)return;
  ctx.log.info("pagination_delivery_interrupted",{plugin:"deepwiki",published:delivery.published,total:delivery.total,category:ui.deliveryErrorCategory(delivery.error)});
  if(!delivery.published)throw delivery.error;
  try{await ctx.telegram.reply(message,ui.interruptedNotice(delivery),{parseMode:"html"});}catch{}
}
export default function createDeepWiki(){return definePlugin({renderHelp: renderPluginHelp, apiVersion:1,id:"deepwiki",description:"基于 DeepWiki 查询 GitHub 项目文档",async setup(ctx){const db=store(ctx);const current=await db.read();if(current.legacyImported)return;const legacyMain=await ctx.storage.json<any>("config.json",{}).read();const legacyContext=await ctx.storage.json<any>("context.json",{}).read();await db.update(data=>{if(data.legacyImported)return data;const chats={...((legacyMain?.chats&&typeof legacyMain.chats==="object")?legacyMain.chats:{}),...data.chats};for(const [chatId,value] of Object.entries((legacyContext?.chats&&typeof legacyContext.chats==="object")?legacyContext.chats:{})){const old=value as any;const target=chats[chatId]??empty();chats[chatId]={...target,contextEnabled:!!old?.contextEnabled,turns:old?.contextTurns&&typeof old.contextTurns==="object"?old.contextTurns:target.turns};}return{schemaVersion:1,chats,legacyImported:true};});},commands:{deepwiki:{helpArgs: ["help","h"], helpOnEmpty: true, description:"管理项目并向 DeepWiki 提问",async handle(invocation,ctx){const chatKey=key(invocation.message);const data=await store(ctx).read();const state=data.chats[chatKey]??empty();const args=[...invocation.args];const sub=(args[0]??"").toLowerCase();const save=async()=>{await store(ctx).update(d=>({...d,schemaVersion:1,chats:{...d.chats,[chatKey]:state}}));};try{
if(!sub||sub==="help"||sub==="h"||sub==="?"){await ctx.telegram.edit(invocation.message,renderPluginHelp(invocation.prefix),{parseMode:"html"});return;}
if(sub==="add"){const tag=args[1]?.trim(),parsed=repoUrl(args[2]??"");if(!tag||!/^[\w.-]{1,40}$/.test(tag)||!parsed)throw new Error("用法：deepwiki add <tag> <GitHub URL>");state.repos[tag]={tag,...parsed,addedAt:new Date().toISOString()};state.currentTag=tag;await save();await ctx.telegram.edit(invocation.message,`✅ 已添加 <code>${esc(tag)}</code>：<code>${esc(parsed.repo)}</code>`,{parseMode:"html"});return;}
if(sub==="lst"){const rows=Object.values(state.repos).sort((a,b)=>a.tag.localeCompare(b.tag)).map(x=>ui.concat(ui.text(`${x.tag===state.currentTag?"✅":"•"} `),ui.code(x.tag),ui.text(` — ${x.repo}`)));await deliver(ctx,invocation.message,await renderDocument({title:"项目列表",sections:[ui.section(undefined,rows.length?rows:[ui.text("暂无项目")])]}));return;}
if(sub==="use"){const tag=args[1]??"";if(!state.repos[tag])throw new Error("项目不存在");state.currentTag=tag;await save();await ctx.telegram.edit(invocation.message,`✅ 已切换到 <code>${esc(tag)}</code>`,{parseMode:"html"});return;}
if(sub==="del"){const tag=args[1]??"";if(!state.repos[tag])throw new Error("项目不存在");delete state.repos[tag];delete state.turns[tag];if(state.currentTag===tag)state.currentTag="";await save();await ctx.telegram.edit(invocation.message,`✅ 已删除 <code>${esc(tag)}</code>`,{parseMode:"html"});return;}
if(sub==="ctx"){const action=(args[1]??"").toLowerCase();if(action==="on"||action==="off"){state.contextEnabled=action==="on";await save();await ctx.telegram.edit(invocation.message,`✅ 上下文已${state.contextEnabled?"开启":"关闭"}`);return;}if(action==="del"){const requested=args[2];if((requested??"").toLowerCase()==="all")state.turns={};else{const tag=requested??state.currentTag;if(!tag||!state.repos[tag])throw new Error("项目不存在");delete state.turns[tag];}await save();await ctx.telegram.edit(invocation.message,"✅ 上下文已清空");return;}const rows=Object.values(state.repos).sort((a,b)=>a.tag.localeCompare(b.tag)).map(repo=>ui.concat(ui.text(`${repo.tag===state.currentTag?"✅":"•"} `),ui.code(repo.tag),ui.text("（缓存轮数："),ui.bold(String((state.turns[repo.tag]??[]).length)),ui.text("）")));await deliver(ctx,invocation.message,await renderDocument({title:"📜 上下文状态",sections:[ui.section(undefined,[ui.text(`• 上下文已${state.contextEnabled?"开启":"关闭"}`),...rows])]}));return;}
const reply=invocation.message.replyToId!==undefined?await ctx.telegram.getReply(invocation.message):undefined;ctx.signal.throwIfAborted();let tag=state.currentTag,q=args.join(" ").trim();if(state.repos[args[0]!]&&(args.length>1||!!reply?.text)){tag=args.shift()!;q=args.join(" ").trim();}if(reply?.text)q=`${reply.text}\n\n${q}`.trim();if(!tag||!state.repos[tag])throw new Error("尚未设置可用项目");if(!q)throw new Error("请输入问题内容");const turns=state.contextEnabled?(state.turns[tag]??[]).slice(-MAX_TURNS):[];const final=state.contextEnabled?questionWithContext(turns,q):prefixText(q,MAX_QUESTION);await ctx.telegram.edit(invocation.message,"💬 <b>DeepWiki 正在处理</b>",{parseMode:"html"});const answer=await ask(ctx,state.repos[tag]!.repo,final);ctx.signal.throwIfAborted();if(state.contextEnabled){state.turns[tag]=[...turns,{q,a:prefixText(answer,12000),at:new Date().toISOString()}].slice(-MAX_TURNS);await save();}await deliver(ctx,invocation.message,await render(state.repos[tag]!.repo,q,prefixText(answer,MAX_QUESTION)));
}catch{if(!ctx.signal.aborted)await ctx.telegram.edit(invocation.message,"❌ DeepWiki 操作失败，请检查参数或稍后重试");}}}}});}
