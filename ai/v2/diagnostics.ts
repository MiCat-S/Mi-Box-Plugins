import type {PluginContext} from "telebox/sdk";
import {
  assertAllowedModel, buildChatRequest, listProviderModels, normalizeOpenAIBaseUrl, parseChatText, readBody,
  resolveProviderType, type ChatConfigSnapshot, type ProviderConfig,
} from "./provider";

export type DiagnosticError = "invalid"|"forbidden"|"limited"|"timeout"|"unavailable"|"invalid_response";
export type Usage = {prompt:number;completion:number;total:number};
export type ChatProbe = {ok:true;text:string;model:string;elapsedMs:number;usage?:Usage;rateLimits?:Record<string,string>}
  | {ok:false;error:DiagnosticError;elapsedMs:number};
export type DiagnosticResult = {provider:{tag:string;type:string;displayName:string};
  balance:{status:"ok"|"unsupported"|"invalid"|"error";fields:readonly {label:string;value:string}[]};
  chat?:ChatProbe;models?:{ok:true;names:string[]}|{ok:false;error:DiagnosticError};
  benchmarks?:readonly ({model:string}&ChatProbe)[]};
export type DiagnosticsInput = {action:"full";tag:string}|{action:"benchmark";tag:string;models?:readonly string[]};
const benchmarkModels:Readonly<Record<string,readonly string[]>>={
  openai:["gpt-4.1-mini","gpt-4.1-nano","gpt-4o-mini"],deepseek:["deepseek-chat","deepseek-reasoner"],
  openrouter:["openai/gpt-4.1-mini","anthropic/claude-3.5-haiku","google/gemini-2.5-flash"],
  groq:["llama-3.3-70b-versatile","mixtral-8x7b-32768","gemma2-9b-it"],
  together:["meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8","Qwen/Qwen3-235B-A22B"],
  fireworks:["accounts/fireworks/models/llama-v3p3-70b-instruct","accounts/fireworks/models/deepseek-v3"],
  mistral:["mistral-small-2506","codestral-2501"],perplexity:["sonar-reasoning","sonar-pro"],
  siliconflow:["Qwen/Qwen3-8B","deepseek-ai/DeepSeek-V3"],deepinfra:["meta-llama/Llama-4-Maverick-17B-128E-Instruct"],
  vercel:["gpt-4o-mini"],azure:["gpt-4o-mini"],xai:["grok-3-mini","grok-2-latest"],
  nvidia:["nvidia/llama-3.1-nemotron-ultra-253b-v1"],
  novita:["deepseek/deepseek-v3-0324","meta-llama/Llama-3.3-70B-Instruct"],cerebras:["llama3.1-8b","llama3.3-70b"],
};

const HEADER_NAMES = new Set(["retry-after","ratelimit-limit","ratelimit-remaining","ratelimit-reset",
  "x-ratelimit-limit-requests","x-ratelimit-remaining-requests","x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens","x-ratelimit-remaining-tokens","x-ratelimit-reset-tokens"]);
const limits = (headers:Headers):Record<string,string>|undefined => {
  const result:Record<string,string>={};
  for (const name of HEADER_NAMES) {const value=headers.get(name);if(value!==null)result[name]=value.slice(0,256);}
  return Object.keys(result).length?result:undefined;
};
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const number=(value:unknown):number=>typeof value==="number"&&Number.isFinite(value)?value:0;
const classify=(code:unknown,status?:number):DiagnosticError => status===401?"invalid":status===403?"forbidden":status===429?"limited":
  code==="TIMEOUT"?"timeout":code==="INVALID_RESPONSE"||code==="INVALID_JSON"?"invalid_response":"unavailable";
function configured(config:ChatConfigSnapshot,tag:string):ProviderConfig {const provider=config.configs[tag];if(!tag||!provider)throw new Error("invalid tag");return provider;}
function identity(tag:string,provider:ProviderConfig){
  const type=resolveProviderType(provider),host=(()=>{try{return new URL(provider.url).hostname.toLowerCase();}catch{return "";}})();
  const detected:[[string,string],...[string,string][]]=[["openrouter","openrouter"],["deepseek","deepseek"],["groq","groq"],
    ["together","together"],["fireworks","fireworks"],["mistral","mistral"],["perplexity","perplexity"],
    ["siliconflow","siliconflow"],["deepinfra","deepinfra"],["vercel","vercel"],["azure","azure"],["x.ai","xai"],
    ["nvidia","nvidia"],["novita","novita"],["cerebras","cerebras"]];
  const branch=detected.find(([part])=>host.includes(part))?.[1]??type;
  const names:Record<string,string>={openai:"OpenAI",openrouter:"OpenRouter",deepseek:"DeepSeek",gemini:"Google Gemini",
    anthropic:"Anthropic",xai:"xAI (Grok)",nvidia:"NVIDIA NIM",novita:"Novita",cerebras:"Cerebras"};
  return {tag,type:branch,displayName:names[branch]??"OpenAI 兼容 API"};
}
async function request(ctx:PluginContext,signal:AbortSignal,url:string,init:RequestInit,timeoutMs:number){
  const started=Date.now();
  try{
    return await ctx.http.withResponse(url,init,async(response,activeSignal)=>{
      const rateLimits=limits(response.headers);
      try {
        const raw=await readBody(response,activeSignal,2*1024*1024);
        const data:unknown=raw.trim()?JSON.parse(raw):{};
        return {ok:response.ok,status:response.status,data,elapsedMs:Date.now()-started,rateLimits};
      }catch(error){
        signal.throwIfAborted();
        return {ok:false,status:response.status,elapsedMs:Date.now()-started,rateLimits,
          error:classify(object(error).code,response.status)};
      }
    },{signal,timeoutMs});
  }catch(error){
    signal.throwIfAborted();
    return {ok:false,elapsedMs:Date.now()-started,error:classify(object(error).code)};
  }
}
function auth(provider:ProviderConfig,type:string):Record<string,string>{
  if(type==="anthropic")return {"x-api-key":provider.key,"anthropic-version":"2023-06-01","content-type":"application/json"};
  return {Authorization:`Bearer ${provider.key}`};
}
async function chat(ctx:PluginContext,signal:AbortSignal,config:ChatConfigSnapshot,tag:string,model:string,max=50):Promise<ChatProbe>{
  assertAllowedModel(model);
  const provider=configured(config,tag);
  const selected={...config,configs:{...config.configs,[tag]:{...provider,stream:false}},
    currentChatTag:tag,currentChatModel:model,currentChatReasoningEffort:"auto" as const,currentChatServiceTier:"auto" as const};
  const built=buildChatRequest(selected,"ok","",{maxOutputTokens:max,temperature:0}),started=Date.now();
  try{return await ctx.http.withResponse(built.url,built.init,async(response,signal)=>{
    const rateLimits=limits(response.headers),elapsedMs=Date.now()-started;
    if(!response.ok)return {ok:false,error:classify(undefined,response.status),elapsedMs} as ChatProbe;
    try {const raw=await readBody(response,signal,2*1024*1024),payload=object(JSON.parse(raw));
      const usage=object(payload.usage??payload.usageMetadata);
      const prompt=number(usage.prompt_tokens??usage.input_tokens??usage.promptTokenCount);
      const completion=number(usage.completion_tokens??usage.output_tokens??usage.candidatesTokenCount);
      const total=number(usage.total_tokens)||prompt+completion;
      return {ok:true,text:parseChatText(raw,built.format,{maxResponseBytes:2*1024*1024,maxOutputChars:1024*1024}),
        model:typeof payload.model==="string"?payload.model:model,elapsedMs:Date.now()-started,...(total?{usage:{prompt,completion,total}}:{}),...(rateLimits?{rateLimits}:{})};
    }catch(error){signal.throwIfAborted();return {ok:false,error:classify(object(error).code),elapsedMs:Date.now()-started} as ChatProbe;}
  },{signal,timeoutMs:built.timeoutMs});}catch(error){signal.throwIfAborted();return {ok:false,error:classify(object(error).code),elapsedMs:Date.now()-started};}
}
async function safeChat(ctx:PluginContext,signal:AbortSignal,config:ChatConfigSnapshot,tag:string,model:string):Promise<ChatProbe>{
  try{return await chat(ctx,signal,config,tag,model);}
  catch(error){signal.throwIfAborted();return {ok:false,error:classify(object(error).code),elapsedMs:0};}
}
type Balance = DiagnosticResult["balance"];
const responseStatus = (value:object):number|undefined => "status" in value ? (value as {status?:number}).status : undefined;
const responseData = (value:object):Record<string,unknown> => object("data" in value ? (value as {data?:unknown}).data : undefined);

async function openAiBalance(ctx:PluginContext,signal:AbortSignal,provider:ProviderConfig):Promise<Balance> {
  const root=normalizeOpenAIBaseUrl(provider.url).replace(/\/?$/, "/");
  const headers=auth(provider,"openai"),now=Math.floor(Date.now()/1000);
  const [subscription,usage,modelData]=await Promise.all([
    request(ctx,signal,new URL("dashboard/billing/subscription",root).toString(),{headers},10_000),
    request(ctx,signal,new URL(`dashboard/billing/usage?start_date=${now-90*86400}&end_date=${now}`,root).toString(),{headers},10_000),
    request(ctx,signal,new URL("models",root).toString(),{headers},10_000),
  ]);
  signal.throwIfAborted();
  const status=responseStatus(subscription);
  if(!subscription.ok&&(status===401||status===403))return {status:"invalid",fields:[]};
  const data=responseData(subscription),plan=object(data.plan);
  const fields:{label:string;value:string}[]=subscription.ok ? [
    {label:"套餐",value:String(plan.title??"?")},
    {label:"硬上限",value:String(data.hard_limit_usd??"?")},
    {label:"软上限",value:String(data.soft_limit_usd??"?")},
    {label:"系统上限",value:String(data.system_hard_limit_usd??"?")},
  ] : [{label:"账单",value:"可能为 platform key，无法查看"}];
  if(data.access_until!==undefined)fields.push({label:"有效期",value:new Date(number(data.access_until)*1000).toLocaleDateString("zh-CN")});
  if(data.has_payment_method!==undefined)fields.push({label:"支付方式",value:data.has_payment_method?"是":"否"});
  if(usage.ok)fields.push({label:"近 90 天",value:`$${(number(responseData(usage).total_usage)/100).toFixed(4)}`});
  if(modelData.ok){
    const value=responseData(modelData),rows=Array.isArray(value.data)?value.data:[],owners=new Set<string>();let tier="";
    for(const row of rows.slice(0,50)){const item=object(row);if(typeof item.owned_by==="string")owners.add(item.owned_by);if(typeof item.max_tier==="string")tier=item.max_tier;}
    if(owners.size)fields.push({label:"Org",value:[...owners].slice(0,3).join(", ")});
    if(tier)fields.push({label:"Tier",value:tier});
  }
  return {status:"ok",fields};
}

async function anthropicBalance(ctx:PluginContext,signal:AbortSignal,provider:ProviderConfig,origin:string,model:string):Promise<Balance>{
  if(!model)return {status:"unsupported",fields:[{label:"余额",value:"请前往官网查看"}]};
  const response=await request(ctx,signal,`${origin}/v1/messages`,{method:"POST",headers:auth(provider,"anthropic"),
    body:JSON.stringify({model,max_tokens:1,messages:[{role:"user",content:"hi"}]})},15_000);
  const status=responseStatus(response);
  if(response.ok||status===429)return {status:"ok",fields:[{label:"Key",value:`有效 (${status===429?"限流":"正常"})`},{label:"余额",value:"请前往官网查看"}]};
  return {status:status===401||status===403?"invalid":"error",fields:[]};
}

async function balance(ctx:PluginContext,signal:AbortSignal,provider:ProviderConfig,branch:string,model:string):Promise<Balance>{
  const base=normalizeOpenAIBaseUrl(provider.url),origin=(()=>{try{return new URL(provider.url).origin;}catch{return provider.url;}})();
  if(branch==="openai")return openAiBalance(ctx,signal,provider);
  if(branch==="anthropic")return anthropicBalance(ctx,signal,provider,origin,model);
  const kind=branch;
  const url=branch==="openrouter"?`${origin}/api/v1/auth/key`:branch==="deepseek"?`${origin}/user/balance`:
    branch==="gemini"?`${origin}/v1beta/models?key=${encodeURIComponent(provider.key)}`:`${base.replace(/\/$/,"")}/models`;
  const response=await request(ctx,signal,url,{headers:auth(provider,branch)},10_000);
  if(!response.ok){const status=responseStatus(response);return {status:status===401||status===403?"invalid":"error",fields:[]};}
  const data=responseData(response),root=object(data.data??data),fields:{label:string;value:string}[]=[];
  if(kind==="openrouter"){
    fields.push({label:"标签",value:String(root.label??root.name??"?")},{label:"余额",value:String(root.credits??"?")},{label:"已用",value:String(root.usage??"?")},{label:"限额",value:String(root.limit??"?")});
    const rate=object(root.rate_limit);if(Object.keys(rate).length)fields.push({label:"速率",value:`${String(rate.requests??"?")} req / ${String(rate.interval??"?")}`});
    if(Array.isArray(root.disabled_providers)&&root.disabled_providers.length)fields.push({label:"禁用",value:String(root.disabled_providers.length)});
  }else if(kind==="deepseek"){
    fields.push({label:"可用",value:data.is_available?"是":"否"});
    for(const row of Array.isArray(data.balance_infos)?data.balance_infos:[]){const item=object(row);fields.push({label:String(item.currency??"余额"),value:String(item.total_balance??"?")});}
  }else{
    const rows=Array.isArray(data.data)?data.data:Array.isArray(data.models)?data.models:[];
    fields.push({label:"状态",value:"有效"},{label:"模型",value:String(rows.length)});
  }
  return {status:"ok",fields};
}
export async function diagnostics(ctx:PluginContext,config:ChatConfigSnapshot,input:DiagnosticsInput,signal:AbortSignal):Promise<DiagnosticResult>{
  const provider=configured(config,input.tag),providerInfo=identity(input.tag,provider);
  if(input.action==="benchmark"){
    let models=input.models??benchmarkModels[providerInfo.type];
    if(!models){
      const configuredModel=provider.models?.chat||(config.currentChatTag===input.tag?config.currentChatModel:"");
      models=configuredModel?[configuredModel]:(await listProviderModels(config,ctx.http,input.tag,signal)).slice(0,1);
    }
    if(models.length<1||models.length>3)throw new Error("invalid benchmark models");
    const benchmarks=[];
    for(const model of models){
      signal.throwIfAborted();
      benchmarks.push({model,...await safeChat(ctx,signal,config,input.tag,model)});
      signal.throwIfAborted();
    }
    return {provider:providerInfo,balance:{status:"unsupported",fields:[]},benchmarks};
  }
  const selectedModel=provider.models?.chat||(config.currentChatTag===input.tag?config.currentChatModel:"");
  const accountTask=balance(ctx,signal,provider,providerInfo.type,selectedModel);
  const modelsTask=listProviderModels(config,ctx.http,input.tag,signal).then(
    names=>({ok:true as const,names}),
    error=>{signal.throwIfAborted();return {ok:false as const,error:classify(object(error).code)};},
  );
  const [account,models]=await Promise.all([accountTask,modelsTask]);
  signal.throwIfAborted();
  const model=provider.models?.chat||(config.currentChatTag===input.tag?config.currentChatModel:"")||(models.ok?models.names[0]??"":"");
  const result={provider:providerInfo,balance:account,models,...(model?{chat:await safeChat(ctx,signal,config,input.tag,model)}:{})};
  signal.throwIfAborted();
  return result;
}
