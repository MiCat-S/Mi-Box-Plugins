import {setTimeout as sleep} from "node:timers/promises";
import {SAFE_REGEXP_LIMITS, STRUCTURED_PLUGIN_API_VERSION, definePlugin, requireSdkFeatures, renderCommandHelp, ui, type CommandDefinition, type CommandInvocation, type SubcommandDefinition, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {returnBigInt} from "teleproto/Helpers";

type Task = {id:number; chatId:string; key:string; response:string; include:boolean; regexp:boolean; exact:boolean; caseSensitive:boolean; ignoreForward:boolean; reply:boolean; deleteSource:boolean; banSeconds:number; restrictSeconds:number; deleteReplyAfter:number; deleteSourceAfter:number};
type State = {schemaVersion:1; nextId:number; tasks:Task[]; aliases:Record<string,string>; importedLegacy:boolean; [key:string]:unknown};
const defaults:State={schemaVersion:1,nextId:1,tasks:[],aliases:{},importedLegacy:false};
const store=(ctx:PluginContext)=>ctx.storage.json<State>("config.json",defaults);
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[c]!);
const err=(e:unknown)=>e instanceof Error?e.message:String(e);
const MAX_REGEXP_TASKS=32;
const MAX_REGEXP_PATTERN=500;

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
  if(task.regexp){if(task.key.length>MAX_REGEXP_PATTERN)throw new Error(`正则表达式不能超过 ${MAX_REGEXP_PATTERN} 个字符`);try{new RegExp(task.key,task.caseSensitive?"":"i");}catch{throw new Error("正则表达式无效");}}
  return task;
}

async function matches(task:Task,message:MessageEnvelope,ctx:PluginContext){if(!message.text||(task.ignoreForward&&message.forwarded))return false;let text=message.text,key=task.key;if(task.regexp){if(key.length>MAX_REGEXP_PATTERN||text.length>SAFE_REGEXP_LIMITS.maxInputLength)return false;try{const result=await ctx.regexp.test(key,text,{flags:task.caseSensitive?"":"i"},ctx.signal);if(result.timedOut)ctx.log.error("keyword_regexp_timeout",{taskId:task.id});return result.matched;}catch(e){ctx.signal.throwIfAborted();ctx.log.error("keyword_regexp_failed",{taskId:task.id,error:err(e).slice(0,200)});return false;}}if(!task.caseSensitive){text=text.toLowerCase();key=key.toLowerCase();}return task.exact?text===key:task.include&&text.includes(key);}
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

// Fails explicitly instead of silently ignoring the listener filter on an older host.
requireSdkFeatures("messageFilter", "safeRegexp");

const guarded = (operation: (invocation: CommandInvocation, ctx: PluginContext, state: State) => Promise<void>): CommandDefinition["handle"] => async (invocation, ctx) => {
  try { await operation(invocation, ctx, await store(ctx).read()); }
  catch (e) { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `操作失败：<code>${esc(err(e))}</code>`, {parseMode: "html"}); }
};
const list = (all: boolean): CommandDefinition["handle"] => guarded(async (invocation, ctx, state) => {
  const items = all ? state.tasks : state.tasks.filter(t => t.chatId === invocation.message.chatId);
  const text=items.length ? items.map(t => `<code>${t.id}</code> - <code>${esc(t.key)}</code>${all ? ` - <code>${esc(t.chatId)}</code>` : ""} - ${esc(t.response)}`).join("\n") : all ? "当前没有任何关键词任务" : "当前聊天没有任何关键词任务";
  const pages=(await ui.renderRichText(text,ui.PAGE_LABEL_RESERVE)).map((page,index,allPages)=>page+ui.pageLabel(index,allPages.length));
  const delivered=await ui.deliverPages(pages,ctx.signal,(page,index)=>index?ctx.telegram.reply(invocation.message,page,{parseMode:"html"}):ctx.telegram.edit(invocation.message,page,{parseMode:"html"}));
  if(delivered.interrupted&&!delivered.published)throw delivered.error;
});
const removeAlias: SubcommandDefinition = {description: "删除当前聊天的继承设置", args: "", examples: [{args: "rm"}], handle: guarded(async (invocation, ctx) => {
  await store(ctx).update(value => { const aliases = {...value.aliases}; delete aliases[invocation.message.chatId]; return {...value, aliases}; });
  await ctx.telegram.edit(invocation.message, "已删除继承设置", {parseMode: "html"});
})};
const command: CommandDefinition = {
  description: "管理关键词回复", helpArgs: ["h", "help"], helpOnEmpty: true, args: "[关键词任务全文]", subcommandsCaseSensitive: false,
  subcommands: {
    list: {description: "查看当前聊天任务", args: "", examples: [{args: "list"}], subcommandsCaseSensitive: true,
      subcommands: {all: {description: "查看所有聊天的关键词任务", args: "", examples: [{args: "all"}], handle: list(true)}}, handle: list(false)},
    rm: {description: "批量删除指定 ID 的任务", args: "ID[,ID...]", examples: [{args: "rm 1,2,3"}], handle: guarded(async (invocation, ctx) => {
      const ids = (invocation.args[0] ?? "").split(",").map(Number);
      if (!ids.length || ids.some(x => !Number.isSafeInteger(x))) throw new Error("请输入正确的任务 ID");
      let removed = 0;
      await store(ctx).update(value => ({...value, tasks: value.tasks.filter(t => ids.includes(t.id) ? (removed++, false) : true)}));
      await ctx.telegram.edit(invocation.message, `已删除 <code>${removed}</code> 个任务。`, {parseMode: "html"});
    })},
    alias: {description: "查看或设置当前聊天继承的群 ID", args: "[群ID]", examples: [{args: "alias"}, {args: "alias 123456"}],
      subcommandsCaseSensitive: true, subcommands: {rm: removeAlias},
      handle: guarded(async (invocation, ctx, state) => {
        const target = invocation.args[0], chatId = invocation.message.chatId;
        if (!target) { await ctx.telegram.edit(invocation.message, state.aliases[chatId] ? `当前群组继承自：<code>${esc(state.aliases[chatId])}</code>` : "当前群组没有继承设置", {parseMode: "html"}); return; }
        await store(ctx).update(value => ({...value, aliases: {...value.aliases, [chatId]: String(target)}}));
        await ctx.telegram.edit(invocation.message, `已添加继承：<code>${esc(target)}</code>`, {parseMode: "html"});
      })},
  },
  help: [{heading: "完整任务格式与示例：", body: `<b>📝 添加关键词任务格式：</b>
<code>{prefix}keyword 关键词内容
+++
回复消息内容
+++
匹配选项
+++
执行动作
+++
延迟删除秒数
+++
原消息延迟删除秒数</code>

<b>🎯 匹配选项（第3段，空格分隔）：</b>
• <code>include</code> - 包含匹配（默认）
• <code>exact</code> - 精确匹配
• <code>regexp</code> - 正则表达式匹配
• <code>case</code> - 区分大小写
• <code>ignore_forward</code> - 忽略转发消息

<b>⚡ 执行动作（第4段，空格分隔）：</b>
• <code>reply</code> - 回复消息（默认）
• <code>delete</code> - 删除触发消息
• <code>ban300</code> - 封禁用户300秒
• <code>restrict600</code> - 限制用户600秒

<b>🔤 消息变量：</b>
• <code>$mention</code> - @提及用户
• <code>$code_id</code> - 用户ID
• <code>$code_name</code> - 用户姓名
• <code>$delay_delete</code> - 延迟删除时间

<b>📖 使用示例：</b>

<b>1. 简单关键词回复：</b>
<code>{prefix}keyword 你好
+++
欢迎！$mention</code>

<b>2. 精确匹配+删除原消息：</b>
<code>{prefix}keyword 违规词汇
+++
⚠️ 请注意言辞！
+++
exact case
+++
reply delete</code>

<b>3. 正则表达式+延迟删除：</b>
<code>{prefix}keyword \\d{11}
+++
🚫 请勿发送手机号码
+++
regexp
+++
reply delete
+++
10
+++
0</code>

<b>4. 封禁用户：</b>
<code>{prefix}keyword 广告
+++
🚫 检测到广告，用户已被封禁
+++
include
+++
reply delete ban3600</code>

<b>💡 高级功能：</b>
• <b>继承机制：</b>可以让当前群组继承其他群组的关键词设置
• <b>延迟删除：</b>支持定时删除回复消息和原消息
• <b>批量管理：</b>支持批量删除多个任务
• <b>灵活匹配：</b>支持包含、精确、正则三种匹配模式

<b>⚠️ 注意事项：</b>
• 封禁和限制功能需要当前账号有管理员权限
• 正则表达式按原文输入，例如 \\d 表示数字
• 继承功能会同时检查当前群组和继承群组的关键词
• 任务ID在删除后不会重复使用

`}],
  handle: guarded(async ({message, args, prefix}, ctx) => {
    const action = args[0]?.toLowerCase();
    if (!action || action === "h" || action === "help") { await ctx.telegram.edit(message, help(prefix), {parseMode: "html"}); return; }
    const raw = message.text.slice(message.text.indexOf(" ") + 1);
    let allocatedId = 0;
    await store(ctx).update(value => {
      const nextId = Math.max(Number(value.nextId) || 1, ...value.tasks.map(task => task.id + 1));
      const task = parseTask(raw, nextId, message.chatId);
      if(task.regexp&&value.tasks.filter(item=>item.regexp).length>=MAX_REGEXP_TASKS)throw new Error(`正则任务最多 ${MAX_REGEXP_TASKS} 条`);
      allocatedId = task.id;
      return {...value, nextId: task.id + 1, tasks: [...value.tasks, task]};
    });
    await ctx.telegram.edit(message, `已添加关键词任务，ID 为 <code>${allocatedId}</code>。`, {parseMode: "html"});
  }),
};
const help = (prefix: string) => renderCommandHelp("keyword", command, {prefix, title: "🔧 关键词回复插件"});
const keywordPlugin = definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "keyword", description: "按聊天配置关键词回复、删除和成员处置", renderHelp: help, commands: {keyword: command},
listeners:[{edited:false,ignoreCommands:false,direction:"incoming",async handle(message,ctx){if(!message.text)return;const state=await store(ctx).read();const inherited=state.aliases[message.chatId];const ordered=[...(inherited?state.tasks.filter(t=>t.chatId===inherited):[]),...state.tasks.filter(t=>t.chatId===message.chatId)];let regexpCount=0;for(const task of ordered){ctx.signal.throwIfAborted();if(task.regexp&&++regexpCount>MAX_REGEXP_TASKS)continue;if(await matches(task,message,ctx))await apply(ctx,message,task);}}}],async setup(ctx){await migrate(ctx);}});
export default function createKeyword(){return keywordPlugin;}
