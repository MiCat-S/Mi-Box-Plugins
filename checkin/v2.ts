import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type MessageEnvelope, type PluginContext, type SubcommandDefinition} from "telebox/sdk";

const SCHEMA_VERSION = 1;
const TIME_ZONE = "Asia/Shanghai";
const BOT_HOST = "api.telegram.org";
const POLL_MS = 1_000;
const POLL_TIMEOUT_MS = 10_000;
const RECOVERY_GRACE_MS = 6 * 60 * 60_000;

type Target = {id:string; name:string; target:string; command:string; callbackData?:string; buttonText?:string; enabled:boolean};
type Pending = {promptId:number; id:string; name:string; target:string; callbackData?:string; buttonText?:string};
type ExecutionTarget = {status:"prepared"|"sent"; success?:boolean; message?:string};
type Execution = {date:string; plannedAt:number; status:"prepared"|"sent"; startedAt?:number; completedAt?:number; targets?:Record<string,ExecutionTarget>};
type State = {
  schemaVersion:number; runTime:string; runTimeEnd?:string; randomDelay:number; logChat:string;
  botToken:string; pushChatId:string; targets:Target[]; lastRunDate:string;
  execution?:Execution; pending:Record<string,Pending>; legacyImported:boolean; [key:string]:unknown;
};
type Result = {success:boolean; message:string};

const defaults = ():State => ({schemaVersion:SCHEMA_VERSION,runTime:"10:00",runTimeEnd:"11:30",randomDelay:0,
  logChat:"",botToken:"",pushChatId:"",targets:[],lastRunDate:"",pending:{},legacyImported:false});
const store = (ctx:PluginContext) => ctx.storage.json<State>("state.json",defaults());
const esc = (value:unknown) => String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]!);
const safeError = (error:unknown) => error && typeof error === "object" && "code" in error ? String((error as {code?:unknown}).code||"执行失败") : "执行失败";
const time = (value:unknown):value is string => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const integer = (value:unknown,min:number,max:number,fallback:number) => typeof value === "number"&&Number.isInteger(value)&&value>=min&&value<=max?value:fallback;
const target = (value:any):Target|undefined => {
  if(!value||typeof value!=="object")return;
  const id=String(value.id??"").trim(),name=String(value.name??"").trim(),peer=String(value.target??"").trim(),command=String(value.command??"").trim();
  if(!id||!name||!peer||!command)return;
  return {id,name,target:peer,command,...(value.callbackData?{callbackData:String(value.callbackData)}:{}),
    ...(value.buttonText?{buttonText:String(value.buttonText)}:{}),enabled:value.enabled!==false};
};
function normalize(value:any):State {
  const base=defaults(), seen=new Set<string>(), targets:Target[]=[];
  for(const item of Array.isArray(value?.targets)?value.targets:[]){const parsed=target(item);if(parsed&&!seen.has(parsed.id)){seen.add(parsed.id);targets.push(parsed);}}
  const pending:Record<string,Pending>={};
  if(value?.pending&&typeof value.pending==="object")for(const [chat,item] of Object.entries(value.pending as Record<string,any>)){
    const promptId=Number(item?.promptId??item?.promptMsgId),id=String(item?.id??"").trim(),name=String(item?.name??"").trim(),peer=String(item?.target??"").trim();
    if(Number.isSafeInteger(promptId)&&promptId>0&&id&&name&&peer)pending[String(chat)]={promptId,id,name,target:peer,
      ...(item.callbackData?{callbackData:String(item.callbackData)}:{}),...(item.buttonText?{buttonText:String(item.buttonText)}:{})};
  }
  const execution=value?.execution&&typeof value.execution==="object"&&typeof value.execution.date==="string"&&
    Number.isFinite(value.execution.plannedAt)&&["prepared","sent"].includes(value.execution.status)?value.execution:undefined;
  return {...value,schemaVersion:SCHEMA_VERSION,runTime:time(value?.runTime)?value.runTime:base.runTime,
    ...(time(value?.runTimeEnd)?{runTimeEnd:value.runTimeEnd}:{}),randomDelay:integer(value?.randomDelay,0,60,0),
    logChat:typeof value?.logChat==="string"?value.logChat:"",botToken:typeof value?.botToken==="string"?value.botToken:"",
    pushChatId:typeof value?.pushChatId==="string"?value.pushChatId:"",targets,lastRunDate:typeof value?.lastRunDate==="string"?value.lastRunDate:"",
    ...(execution?{execution}:{}),pending,legacyImported:value?.legacyImported===true};
}
function localParts(now:number){const fields=new Intl.DateTimeFormat("en-CA",{timeZone:TIME_ZONE,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now);const get=(key:string)=>fields.find(x=>x.type===key)!.value;return{date:`${get("year")}-${get("month")}-${get("day")}`,minutes:Number(get("hour"))*60+Number(get("minute"))};}
function shanghaiEpoch(date:string,minutes:number):number {const [y,m,d]=date.split("-").map(Number);return Date.UTC(y!,m!-1,d!,Math.floor(minutes/60)-8,minutes%60);}
function addDate(date:string,days:number):string {const [y,m,d]=date.split("-").map(Number);return new Date(Date.UTC(y!,m!-1,d!+days)).toISOString().slice(0,10);}
function windowFor(state:State,now:number):{date:string;start:number;end:number}|undefined {
  const local=localParts(now),startMin=Number(state.runTime.slice(0,2))*60+Number(state.runTime.slice(3));
  const endMin=state.runTimeEnd?Number(state.runTimeEnd.slice(0,2))*60+Number(state.runTimeEnd.slice(3)):startMin;
  let date=local.date;if(state.runTimeEnd&&endMin<startMin&&local.minutes<=endMin)date=addDate(date,-1);
  const bounds=(anchor:string)=>({date:anchor,start:shanghaiEpoch(anchor,startMin),end:state.runTimeEnd?shanghaiEpoch(endMin<startMin?addDate(anchor,1):anchor,endMin):shanghaiEpoch(addDate(anchor,1),0)-1});
  let result=bounds(date);if(now<result.start)result=bounds(addDate(date,-1));
  if(now<result.start||now>result.end+RECOVERY_GRACE_MS)return;return result;
}
function plan(state:State,now:number):Execution|undefined {const window=windowFor(state,now);if(!window)return;const span=Math.max(0,window.end-window.start);const plannedAt=state.runTimeEnd?window.start+Math.floor(Math.random()*(span+1)):window.start;return{date:window.date,plannedAt,status:"prepared"};}
function matcher(args:readonly string[]):Pick<Target,"callbackData"|"buttonText"> {const raw=args.join(" ").trim();if(!raw)return{};if(raw.startsWith("text:"))return{buttonText:raw.slice(5).trim()};return{callbackData:(raw.startsWith("data:")?raw.slice(5):raw).trim()};}
function abortableDelay(ms:number,signal:AbortSignal):Promise<void>{if(ms<=0){signal.throwIfAborted();return Promise.resolve();}return new Promise((resolve,reject)=>{const timer=setTimeout(done,ms);function done(){signal.removeEventListener("abort",abort);resolve();}function abort(){clearTimeout(timer);signal.removeEventListener("abort",abort);reject(signal.reason??new Error("aborted"));}signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();});}
function callback(message:any,wanted:Target):Buffer|undefined {for(const row of message?.replyMarkup?.rows??[])for(const button of row?.buttons??[]){const type=button?.type;if(type?.className!=="InlineButtonTypeCallback")continue;const bytes=type.data instanceof Uint8Array||Buffer.isBuffer(type.data)?Buffer.from(type.data):undefined;const data=bytes?bytes.toString("utf8"):String(type.data??"");if(wanted.callbackData?data===wanted.callbackData:button.text===wanted.buttonText)return bytes??Buffer.from(data);}}

export default function createCheckin(){
  let tail=Promise.resolve();
  const serial=<T>(operation:()=>Promise<T>):Promise<T>=>{const result=tail.then(operation,operation);tail=result.then(()=>undefined,()=>undefined);return result;};
  const poll=async(ctx:PluginContext,client:any,peer:string,minDate:number,sentId:number,wanted:Target,button:boolean,signal:AbortSignal)=>{const deadline=Date.now()+POLL_TIMEOUT_MS;while(Date.now()<deadline){await abortableDelay(POLL_MS,signal);const messages=await client.getMessages(peer,{limit:8});for(const message of messages){if(message.out||Number(message.date??0)<minDate||Number(message.id??0)<=sentId)continue;if(!button||callback(message,wanted))return message;}}};
  const single=async(ctx:PluginContext,wanted:Target,signal:AbortSignal):Promise<Result>=>ctx.telegram.withClient(async client=>{signal.throwIfAborted();const sent=await client.sendMessage(wanted.target,{message:wanted.command});const id=Number(sent?.id??0),date=Math.floor(Date.now()/1000);const hasButton=!!(wanted.callbackData||wanted.buttonText);const first=await poll(ctx,client,wanted.target,date,id,wanted,hasButton,signal);if(!first)return{success:false,message:"未收到签到结果"};if(!hasButton)return{success:true,message:String(first.message||"签到命令已发送")};const data=callback(first,wanted);if(!data)return{success:false,message:"未找到签到按钮"};const {Api}=await import("teleproto");await client.invoke(new Api.messages.GetBotCallbackAnswer({peer:wanted.target,msgId:first.id,data}));const second=await poll(ctx,client,wanted.target,Math.floor(Date.now()/1000),Number(first.id??0),wanted,false,signal);return{success:true,message:String(second?.message||first.message||"已点击签到按钮")};});
  const botPush=async(ctx:PluginContext,state:State,text:string)=>{const url=`https://${BOT_HOST}/bot${encodeURIComponent(state.botToken)}/sendMessage`;await ctx.http.withResponse(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:state.pushChatId,text,parse_mode:"HTML"})},async(response,signal)=>{if(response.status!==200||!response.body)throw new Error("bot status");const reader=response.body.getReader(),chunks:Buffer[]=[];let total=0,done=false;try{for(;;){signal.throwIfAborted();const part=await reader.read();if(part.done){done=true;break;}total+=part.value.byteLength;if(total>64*1024)throw new Error("bot response too large");chunks.push(Buffer.from(part.value));}}finally{try{if(!done)await reader.cancel();}catch{}finally{reader.releaseLock();}}let body:any;try{body=JSON.parse(Buffer.concat(chunks,total).toString("utf8"));}catch{throw new Error("bot response invalid");}if(body?.ok!==true)throw new Error("bot rejected");},{redirects:{allowedHosts:[BOT_HOST],maxRedirects:0},timeoutMs:15_000});};
  const all=async(ctx:PluginContext,source:string,fallback:string|undefined,signal:AbortSignal,scheduledDate?:string)=>{const state=normalize(await store(ctx).read()),enabled=state.targets.filter(x=>x.enabled);if(!enabled.length)throw new Error("没有启用的签到目标");const results:Array<{target:Target;result:Result}>=[];for(const [index,item] of enabled.entries()){signal.throwIfAborted();if(scheduledDate){const saved=normalize(await store(ctx).read()).execution?.targets?.[item.id];if(saved){results.push({target:item,result:saved.status==="sent"?{success:saved.success===true,message:saved.message||"已执行"}:{success:false,message:"上次执行状态未确认，已避免重复发送"}});continue;}await store(ctx).update(raw=>{const value=normalize(raw),execution=value.execution;if(!execution||execution.date!==scheduledDate)return value;return{...value,execution:{...execution,targets:{...execution.targets,[item.id]:{status:"prepared"}}}};});}let result:Result;try{result=await single(ctx,item,signal);}catch(error){signal.throwIfAborted();result={success:false,message:safeError(error)};}results.push({target:item,result});if(scheduledDate)await store(ctx).update(raw=>{const value=normalize(raw),execution=value.execution;if(!execution||execution.date!==scheduledDate)return value;return{...value,execution:{...execution,targets:{...execution.targets,[item.id]:{status:"sent",success:result.success,message:result.message.slice(0,500)}}}};});if(index+1<enabled.length)await abortableDelay(2_000,signal);}const ok=results.filter(x=>x.result.success).length;const summary=`🤖 <b>CheckIn 签到汇总报告</b>\n来源: ${esc(source)}\n结果: ${ok} 成功 / ${results.length-ok} 失败\n\n${results.map((x,i)=>`${x.result.success?"✅":"❌"} <b>${i+1}. ${esc(x.target.name)}</b>\n   ${esc(x.result.message)}`).join("\n")}`;let pushed=false;if(state.botToken&&state.pushChatId)try{await botPush(ctx,state,summary);pushed=true;}catch{signal.throwIfAborted();ctx.log.error("checkin_bot_push_failed");}const destination=state.logChat||fallback;if(!pushed&&destination)await ctx.telegram.withClient(async client=>{await client.sendMessage(destination,{message:summary,parseMode:"html",linkPreview:false});});return{ok,total:results.length,summary};};
  const scheduled=async(ctx:PluginContext,signal:AbortSignal,now=Date.now())=>serial(async()=>{let run=false,date="",delay=false;await store(ctx).update(raw=>{const state=normalize(raw),candidate=state.execution?.status==="prepared"?state.execution:plan(state,now);if(!candidate||state.lastRunDate===candidate.date||candidate.status==="sent"||now<candidate.plannedAt)return state;run=true;date=candidate.date;delay=candidate.startedAt===undefined;return{...state,execution:{...candidate,status:"prepared",startedAt:candidate.startedAt??now}};});if(!run)return;try{const current=normalize(await store(ctx).read());if(delay&&current.randomDelay)await abortableDelay(Math.floor(Math.random()*current.randomDelay*60_000),signal);await all(ctx,"自动定时任务",undefined,signal,date);await store(ctx).update(raw=>{const state=normalize(raw);const next:{[key:string]:unknown}={...state,lastRunDate:state.execution?.date??localParts(now).date};if(state.execution)next.execution={...state.execution,status:"sent",completedAt:Date.now()};else delete next.execution;return next as State;});}catch(error){signal.throwIfAborted();ctx.log.error("checkin_scheduled_failed",{code:safeError(error)});}});

  const checkinCommand: CommandDefinition = {
    description: "管理并运行自动签到；无参数时手动触发所有签到",
    helpArgs: ["help", "h"],
    subcommandsCaseSensitive: false,
    subcommands: {
      add: {
        description: "添加签到目标", args: "ID 名称 目标 [data:回调|text:按钮]",
        arguments: [{name: "ID", required: true}, {name: "名称", required: true}, {name: "目标", required: true, description: "Bot 用户名或对话"},
          {name: "匹配", description: "data:回调 或 text:按钮"}],
        examples: [{args: "add storm Storm签到 @storm_bot data:checkin"}],
        async handle(invocation, ctx) {
          const message = invocation.message;
          const [id, name, peer] = invocation.args.slice(0, 3);
          if (!id || !name || !peer) { await ctx.telegram.edit(message, renderCommandHelp("checkin", checkinCommand, {prefix: invocation.prefix, title: "🤖 CheckIn 自动化签到插件"}), {parseMode: "html"}); return; }
          const match = matcher(invocation.args.slice(3));
          const sent = await ctx.telegram.withClient(client => client.sendMessage(message.chatId, {message: "请回复此消息发送签到命令", replyTo: message.id}));
          await store(ctx).update(raw => { const state = normalize(raw);
            return {...state, pending: {...state.pending, [message.chatId]: {promptId: Number(sent.id), id, name, target: peer, ...match}}}; });
        },
      },
      list: {
        description: "列出签到目标", args: "", examples: [{args: "list"}],
        async handle(invocation, ctx) {
          const state = normalize(await store(ctx).read());
          await ctx.telegram.edit(invocation.message, state.targets.length ? state.targets.map((x, i) => `${x.enabled ? "🟢" : "🔴"} ${i + 1}. <b>${esc(x.name)}</b> <code>${esc(x.id)}</code>\n${esc(x.target)} · ${esc(x.command)}`).join("\n\n") : "当前没有签到目标", {parseMode: "html"});
        },
      },
      del: {
        description: "删除签到目标", args: "ID", aliases: ["delete"],
        arguments: [{name: "ID", required: true}], examples: [{args: "del storm"}],
        async handle(invocation, ctx) {
          const id = invocation.args[0];
          if (!id) { await ctx.telegram.edit(invocation.message, "请指定目标 ID"); return; }
          const state = normalize(await store(ctx).read());
          if (!state.targets.find(x => x.id === id)) { await ctx.telegram.edit(invocation.message, "未找到签到目标"); return; }
          await store(ctx).update(raw => { const value = normalize(raw); return {...value, targets: value.targets.filter(x => x.id !== id)}; });
          await ctx.telegram.edit(invocation.message, "✅ 配置已更新");
        },
      },
      toggle: {
        description: "启用或禁用签到目标", args: "ID",
        arguments: [{name: "ID", required: true}], examples: [{args: "toggle storm"}],
        async handle(invocation, ctx) {
          const id = invocation.args[0];
          if (!id) { await ctx.telegram.edit(invocation.message, "请指定目标 ID"); return; }
          const state = normalize(await store(ctx).read());
          if (!state.targets.find(x => x.id === id)) { await ctx.telegram.edit(invocation.message, "未找到签到目标"); return; }
          await store(ctx).update(raw => { const value = normalize(raw); return {...value, targets: value.targets.map(x => x.id === id ? {...x, enabled: !x.enabled} : x)}; });
          await ctx.telegram.edit(invocation.message, "✅ 配置已更新");
        },
      },
      test: {
        description: "测试单个签到目标", args: "ID",
        arguments: [{name: "ID", required: true}], examples: [{args: "test storm"}],
        async handle(invocation, ctx) {
          const id = invocation.args[0];
          if (!id) { await ctx.telegram.edit(invocation.message, "请指定目标 ID"); return; }
          const state = normalize(await store(ctx).read());
          const found = state.targets.find(x => x.id === id);
          if (!found) { await ctx.telegram.edit(invocation.message, "未找到签到目标"); return; }
          const result = await serial(() => single(ctx, found, ctx.signal));
          await ctx.telegram.edit(invocation.message, `${result.success ? "✅" : "❌"} ${esc(result.message)}`, {parseMode: "html"});
        },
      },
      settings: {
        description: "查看当前配置", args: "", aliases: ["info"], examples: [{args: "settings"}],
        async handle(invocation, ctx) {
          const state = normalize(await store(ctx).read());
          await ctx.telegram.edit(invocation.message, `⏰ ${state.runTime}${state.runTimeEnd ? ` ~ ${state.runTimeEnd}` : ""}\n🎲 ${state.randomDelay} 分钟\n🤖 Bot: ${state.botToken ? "已配置" : "未配置"}\n📅 最近执行: ${esc(state.lastRunDate || "无")}\n🎯 ${state.targets.filter(x => x.enabled).length}/${state.targets.length}`, {parseMode: "html"});
        },
      },
      reset: {
        description: "重置今日运行状态", args: "", examples: [{args: "reset"}],
        async handle(invocation, ctx) {
          await store(ctx).update(raw => { const state = normalize(raw); state.lastRunDate = ""; delete state.execution; return state; });
          await ctx.telegram.edit(invocation.message, "✅ 已重置每日运行状态");
        },
      },
      set: {
        description: "修改配置", args: "[time|range|delay|bot|log [值]]",
        aliases: ["config"],
        subcommandsCaseSensitive: false,
        subcommands: {
          time: {
            description: "设置开始时间", args: "HH:MM",
            arguments: [{name: "HH:MM", required: true, description: "24 小时制，例如 10:00"}],
            examples: [{args: "time 10:00"}],
            async handle(invocation, ctx) {
              const value = invocation.args[0];
              if (!time(value)) { await ctx.telegram.edit(invocation.message, renderCommandHelp("checkin", checkinCommand, {prefix: invocation.prefix, title: "🤖 CheckIn 自动化签到插件"}), {parseMode: "html"}); return; }
              await store(ctx).update(raw => { const state = normalize(raw); state.runTime = value; delete state.execution; return state; });
              await ctx.telegram.edit(invocation.message, "✅ 开始时间已更新");
            },
          },
          range: {
            description: "设置执行时间结束点（留空改为固定时间）", args: "[HH:MM]",
            arguments: [{name: "HH:MM", description: "省略时清除时间范围，改为固定时间执行"}],
            examples: [{args: "range 11:30"}, {args: "range"}],
            async handle(invocation, ctx) {
              const value = invocation.args[0];
              if (value && !time(value)) { await ctx.telegram.edit(invocation.message, "时间格式应为 HH:MM"); return; }
              await store(ctx).update(raw => { const state = normalize(raw); if (value) { state.runTimeEnd = value; delete state.execution; return state; } delete state.runTimeEnd; delete state.execution; return state; });
              await ctx.telegram.edit(invocation.message, "✅ 时间范围已更新");
            },
          },
          delay: {
            description: "设置额外随机延迟（0-60 分钟）", args: "分钟",
            arguments: [{name: "分钟", required: true, description: "0 到 60 的整数"}],
            examples: [{args: "delay 5"}],
            async handle(invocation, ctx) {
              const delay = Number(invocation.args[0]);
              if (!Number.isInteger(delay) || delay < 0 || delay > 60) { await ctx.telegram.edit(invocation.message, "随机延迟应为 0-60 分钟"); return; }
              await store(ctx).update(raw => ({...normalize(raw), randomDelay: delay}));
              await ctx.telegram.edit(invocation.message, "✅ 随机延迟已更新");
            },
          },
          bot: {
            description: "设置 Bot 通知（仅收藏夹）", args: "Token ChatID",
            arguments: [{name: "Token", required: true, description: "Bot Token，仅可在收藏夹设置"}, {name: "ChatID", required: true, description: "接收推送的对话 ID"}],
            examples: [{args: "bot <Token> <ChatID>"}],
            async handle(invocation, ctx) {
              const [token, chatId] = invocation.args;
              if (!invocation.message.saved) { await ctx.telegram.edit(invocation.message, "Bot Token 只能在收藏夹中设置"); return; }
              if (!token || !chatId) { await ctx.telegram.edit(invocation.message, "请提供 Token 与 Chat ID"); return; }
              await store(ctx).update(raw => ({...normalize(raw), botToken: token, pushChatId: chatId}));
              await ctx.telegram.edit(invocation.message, `✅ Bot 配置已更新：${esc(token.slice(0, 5))}…`, {parseMode: "html"});
            },
          },
          log: {
            description: "设置日志聊天", args: "ChatID",
            arguments: [{name: "ChatID", required: true, description: "接收汇总的对话 ID"}],
            examples: [{args: "log -100123"}],
            async handle(invocation, ctx) {
              const value = invocation.args[0];
              if (!value) { await ctx.telegram.edit(invocation.message, renderCommandHelp("checkin", checkinCommand, {prefix: invocation.prefix, title: "🤖 CheckIn 自动化签到插件"}), {parseMode: "html"}); return; }
              await store(ctx).update(raw => ({...normalize(raw), logChat: value}));
              await ctx.telegram.edit(invocation.message, "✅ 日志对话已更新");
            },
          },
        },
        examples: [{args: "set time 10:00"}, {args: "set range 11:30"}, {args: "set range"}, {args: "set delay 5"}, {args: "set bot <Token> <ChatID>"}, {args: "set log -100123"}],
        async handle(invocation, ctx) {
          await ctx.telegram.edit(invocation.message, renderCommandHelp("checkin", checkinCommand, {prefix: invocation.prefix, title: "🤖 CheckIn 自动化签到插件"}), {parseMode: "html"});
        },
      },
    },
    examples: [{args: "", description: "手动触发所有签到"}, {args: "reset"}, {args: "add storm Storm签到 @storm_bot data:checkin"}, {args: "set time 10:00"}, {args: "set range 11:30"}, {args: "set range"}],
    help: [
      {heading: "手动触发：", body: "不带参数发送 <code>{prefix}checkin</code> 立即串行执行所有已启用目标；<code>{prefix}checkin reset</code> 重置今日运行状态。"},
      {heading: "添加流程：", body: "<code>{prefix}checkin add ID 名称 目标 [data:回调|text:按钮]</code> 后，回复提示消息发送真实签到命令（可含空格），例如 <code>/sign 123456</code>。"},
      {heading: "时间范围：", body: "时区为 " + TIME_ZONE + "，默认 10:00 ~ 11:30、随机延迟 0 分钟。设置 range 后每天在 time 到 range 之间随机选择一个时刻执行，支持跨天，例如 22:00 到次日 02:00；<code>set range</code> 留空改为固定时间。"},
      {heading: "密钥配置：", body: "涉及 API Key、Token 或其他登录凭据的设置命令请在收藏夹中执行。"},
    ],
    async handle(invocation, ctx) {
      const message = invocation.message;
      if (!invocation.args.length) {
        try {
          await ctx.telegram.edit(message, "🚀 开始执行签到任务…");
          const result = await serial(() => all(ctx, "手动触发", message.chatId, ctx.signal));
          await ctx.telegram.edit(message, `✅ 已执行 ${result.total} 个任务`);
        } catch (error) {
          if (!ctx.signal.aborted) await ctx.telegram.edit(message, `❌ ${esc(error instanceof Error ? error.message : "执行失败")}`, {parseMode: "html"});
        }
        return;
      }
      await ctx.telegram.edit(message, renderCommandHelp("checkin", checkinCommand, {prefix: invocation.prefix, title: "🤖 CheckIn 自动化签到插件"}), {parseMode: "html"});
    },
  };

  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "checkin", description: "定时串行执行 Telegram Bot 签到任务",
    renderHelp: prefix => renderCommandHelp("checkin", checkinCommand, {prefix, title: "🤖 CheckIn 自动化签到插件"}),
    commands: {checkin: checkinCommand},
    listeners: [{direction: "outgoing", edited: false, ignoreCommands: false, async handle(message, ctx) {
      if (message.replyToId === undefined) return;
      const state = normalize(await store(ctx).read()), pending = state.pending[message.chatId];
      if (!pending || message.replyToId !== pending.promptId) return;
      const command = message.text.trim();
      if (!command) { await ctx.telegram.reply(message, "签到命令不能为空"); return; }
      await store(ctx).update(raw => { const value = normalize(raw), existing = value.targets.findIndex(x => x.id === pending.id),
        next: Target = {id: pending.id, name: pending.name, target: pending.target, command, ...(pending.callbackData ? {callbackData: pending.callbackData} : {}), ...(pending.buttonText ? {buttonText: pending.buttonText} : {}), enabled: true},
        targets = [...value.targets];
        if (existing >= 0) targets[existing] = next; else targets.push(next);
        const rest = {...value.pending}; delete rest[message.chatId]; return {...value, targets, pending: rest}; });
      await ctx.telegram.reply(message, `✅ 已保存签到目标：${esc(pending.name)}`, {parseMode: "html"});
    }}],
    jobs: {daily_check: {description: "检查每日签到执行窗口", cron: "* * * * *", timeZone: TIME_ZONE, handle(ctx, signal) { return scheduled(ctx, signal); }}},
    settings: ctx => ({id: "checkin", title: "自动签到", description: "签到时间、通知与目标设置", category: "插件配置", icon: "✅", getSchema: () => [
      {key: "runTime", label: "开始时间", type: "string"}, {key: "runTimeEnd", label: "结束时间", type: "string"}, {key: "randomDelay", label: "随机延迟（分钟）", type: "number", min: 0, max: 60},
      {key: "logChat", label: "日志对话", type: "string"}, {key: "botToken", label: "Bot Token", type: "password", secret: true}, {key: "pushChatId", label: "Bot 推送 Chat ID", type: "string"}, {key: "targets", label: "签到目标", type: "json"}],
      async getValues() { const s = normalize(await store(ctx).read()); return {runTime: s.runTime, runTimeEnd: s.runTimeEnd ?? "", randomDelay: s.randomDelay, logChat: s.logChat, botToken: s.botToken ? "***" : "", pushChatId: s.pushChatId, targets: s.targets}; },
      async setValues(patch) { await store(ctx).update(raw => { const s = normalize(raw);
        if (patch.runTime !== undefined && !time(patch.runTime)) throw new Error("开始时间格式无效");
        if (patch.runTimeEnd !== undefined && patch.runTimeEnd !== "" && !time(patch.runTimeEnd)) throw new Error("结束时间格式无效");
        if (patch.randomDelay !== undefined && integer(patch.randomDelay, 0, 60, -1) < 0) throw new Error("随机延迟无效");
        const next = {...s, ...patch, schemaVersion: SCHEMA_VERSION, botToken: typeof patch.botToken === "string" && patch.botToken !== "***" ? patch.botToken : s.botToken};
        delete next.execution;
        if (patch.runTimeEnd === "") delete next.runTimeEnd;
        return normalize(next); }); }}),
    async setup(ctx) { const current = await store(ctx).read();
      if (!current.legacyImported) { const legacy = await ctx.storage.json<Record<string, unknown>>("checkin_config.json", {}).read();
        await store(ctx).update(raw => { const state = normalize(raw); if (state.legacyImported) return state;
          const imported = Object.keys(legacy).length ? normalize({...state, ...legacy, pending: state.pending, targets: state.targets.length ? state.targets : legacy.targets, botToken: state.botToken || legacy.botToken, pushChatId: state.pushChatId || legacy.pushChatId, logChat: state.logChat || legacy.logChat}) : state;
          return {...imported, legacyImported: true}; }); }
      else await store(ctx).update(raw => normalize(raw)); },
    cleanup() { tail = Promise.resolve(); }});
}
