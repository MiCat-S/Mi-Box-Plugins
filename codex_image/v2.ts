import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type SubcommandDefinition} from "telebox/sdk";
import {readFile} from "node:fs/promises";
import type {PluginContext, MessageEnvelope} from "telebox/sdk";
import type {Api} from "teleproto";
type State={schemaVersion:1;accessToken:string;model:string;maxWaitMs:number;importedLegacy:boolean;[key:string]:unknown};
type Result={image?:string;revised?:string;status?:string;id?:string};
const defaults:State={schemaVersion:1,accessToken:"",model:"gpt-5.4",maxWaitMs:600000,importedLegacy:false};
const ENDPOINT="https://chatgpt.com/backend-api/codex/responses",MAX_INPUT=20*1024*1024,MAX_STREAM=48*1024*1024,MAX_IMAGE=32*1024*1024;
const store=(c:PluginContext)=>c.storage.json<State>("config.json",defaults);
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[x]!);
const wait=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(done,ms);function done(){signal.removeEventListener("abort",abort);resolve();}function abort(){clearTimeout(timer);reject(signal.reason);}signal.addEventListener("abort",abort,{once:true});});
async function migrate(c:PluginContext){const cur=await store(c).read();if(cur.importedLegacy&&cur.schemaVersion===1)return;let source:any=cur;try{source={...JSON.parse(await readFile(c.files.dataPath("config.json"),"utf8")),...cur};}catch{}await store(c).update(()=>({...source,schemaVersion:1,accessToken:typeof source.accessToken==="string"?source.accessToken.trim():"",model:typeof source.model==="string"&&source.model.trim()?source.model.trim():defaults.model,maxWaitMs:Math.max(60000,Math.min(1800000,Number(source.maxWaitMs)||defaults.maxWaitMs)),importedLegacy:true}));}
function visit(value:any,out:Result){if(!value||typeof value!=="object")return;if(typeof value.partial_image_b64==="string")out.image=value.partial_image_b64;if(typeof value.revised_prompt==="string")out.revised=value.revised_prompt;if(typeof value.status==="string")out.status=value.status;if(typeof value.id==="string"&&value.id.startsWith("resp_"))out.id=value.id;for(const child of Array.isArray(value)?value:Object.values(value))visit(child,out);}
async function stream(response:Response,signal:AbortSignal){if(response.status!==200||!response.body)throw new Error("provider_failed");const reader=response.body.getReader(),decoder=new TextDecoder();let pending="",total=0;const out:Result={};try{for(;;){signal.throwIfAborted();const p=await reader.read();if(p.done)break;total+=p.value.byteLength;if(total>MAX_STREAM)throw new Error("response_too_large");pending+=decoder.decode(p.value,{stream:true});let split;while((split=pending.indexOf("\n\n"))>=0){const block=pending.slice(0,split);pending=pending.slice(split+2);for(const line of block.split(/\r?\n/)){if(!line.startsWith("data:"))continue;const value=line.slice(5).trim();if(!value||value==="[DONE]")continue;try{visit(JSON.parse(value),out);}catch{}}}}return out;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
async function jsonResponse(response:Response,signal:AbortSignal){if(response.status!==200||!response.body)throw new Error("provider_failed");const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;try{for(;;){signal.throwIfAborted();const p=await reader.read();if(p.done)break;total+=p.value.byteLength;if(total>MAX_STREAM)throw new Error("response_too_large");chunks.push(p.value);}return JSON.parse(Buffer.concat(chunks,total).toString("utf8"));}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
async function reference(c:PluginContext,m:MessageEnvelope){if(!m.replyToId)return;const reply=await c.telegram.getReply(m);if(!reply?.raw)return;return c.telegram.withClient(async(client,signal)=>{const raw=reply.raw as any,mime=String(raw.media?.document?.mimeType??(raw.media?.photo?"image/jpeg":""));if(!mime.startsWith("image/"))throw new Error("reply_not_image");const chunks:Buffer[]=[];let total=0;for await(const chunk of client.iterDownload(raw.media,{})){signal.throwIfAborted();total+=chunk.length;if(total>MAX_INPUT)throw new Error("image_too_large");chunks.push(Buffer.from(chunk));}if(!total)throw new Error("empty_image");return{mime,data:Buffer.concat(chunks,total).toString("base64"),reply};});}
async function generate(c:PluginContext,state:State,prompt:string,ref:Awaited<ReturnType<typeof reference>>){const content=ref?[{type:"input_text",text:prompt},{type:"input_image",image_url:`data:${ref.mime};base64,${ref.data}`}]:prompt;const payload={model:state.model,instructions:"Generate the requested image.",input:[{role:"user",content}],store:false,tools:[{type:"image_generation"}],reasoning:{effort:"low"},stream:true};const headers={Authorization:`Bearer ${state.accessToken}`,"Content-Type":"application/json"};const result=await c.http.withResponse(ENDPOINT,{method:"POST",redirect:"manual",credentials:"omit",headers,body:JSON.stringify(payload)},stream,{timeoutMs:state.maxWaitMs,signal:c.signal,redirects:{allowedHosts:["chatgpt.com"],maxRedirects:0}});if(result.image||!result.id||result.status!=="in_progress")return result;const deadline=Date.now()+state.maxWaitMs;while(Date.now()<deadline){await wait(Math.min(20000,deadline-Date.now()),c.signal);const polled:any=await c.http.withResponse(`${ENDPOINT}/${encodeURIComponent(result.id)}`,{method:"GET",redirect:"manual",credentials:"omit",headers},jsonResponse,{timeoutMs:Math.min(60000,Math.max(1000,deadline-Date.now())),signal:c.signal,redirects:{allowedHosts:["chatgpt.com"],maxRedirects:0}});const next:Result={};visit(polled?.response??polled,next);if(next.image)return next;if(next.status&&next.status!=="in_progress")return next;}throw new Error("generation_timeout");}

export default function createCodexImage(){
  const token: SubcommandDefinition = {
    description: "设置 Codex Access Token（仅收藏夹）", args: "<Access Token>",
    arguments: [{name: "Access Token", required: true, description: "仅允许在收藏夹中设置；也可在插件设置页填写"}],
    examples: [{args: "token your_access_token"}],
    async handle({message,args,prefix},c){
      if(!message.saved){await c.telegram.edit(message,"Access Token 仅允许在收藏夹中设置");return;}
      if(!args[0]){await c.telegram.edit(message,`用法：${prefix}cximg token <Access Token>`);return;}
      await store(c).update(v=>({...v,accessToken:args.join(" ").trim()}));
      await c.telegram.edit(message,"Codex Access Token 已更新");
    },
  };
  const cximg: CommandDefinition = {
    description: "Codex 图片生成",
    helpArgs: ["help", "h"],
    args: "<提示词>",
    arguments: [{name: "提示词", required: true, description: "生成或编辑图片的提示词"}],
    examples: [{args: "一只坐在窗边的橘猫，水彩插画"}, {args: "保留主体，把背景改成海边。", description: "回复图片后发送"}],
    subcommandsCaseSensitive: false,
    subcommands: {token},
    help: [
      {heading: "首次配置：", body: "在收藏夹执行 <code>{prefix}cximg token AccessToken</code> 保存有效的 Codex Access Token（示例：<code>{prefix}cximg token your_access_token</code>）；也可通过插件设置中的 Access Token 字段保存。Token 过期后重新保存有效值。"},
      {heading: "使用：", body: "直接发送提示词按文字生成；回复图片后发送提示词，会把该图片作为参考图生成结果，结果回复参考消息；成功发送后删除生成命令。"},
      {heading: "插件设置：", body: "模型默认 gpt-5.4；最大等待时间单位毫秒，默认 600000（10 分钟），范围 60000–1800000（1–30 分钟）；流式请求和后续轮询分别受该时间窗口约束。"},
      {heading: "媒体与结果：", body: "参考图需为图片媒体或图片文件，单张下载上限 20 MiB；生成图片上限 32 MiB，结果以 PNG 文件名发送并附提示词。"},
      {heading: "隐私：", body: "提示词和参考图会发送到配置所连接的 Codex 服务。"},
      {heading: "常见提示：", body: "未配置 Token 时先在收藏夹完成设置；生成失败时检查凭据有效性、模型是否支持图片工具、网络以及参考图格式/大小。"},
    ],
    ignoreEdited: true,
    async handle({message,args,prefix},c){
      const state=await store(c).read(),prompt=args.join(" ").trim();
      if(!state.accessToken){await c.telegram.edit(message,"未配置 Codex Access Token");return;}
      if(!prompt){await c.telegram.edit(message,`用法：${prefix}cximg <提示词>`);return;}
      try{const ref=await reference(c,message);await c.telegram.edit(message,ref?"已读取参考图，正在生成…":"正在生成图片…");const result=await generate(c,state,prompt,ref);if(!result.image)throw new Error("empty_result");const image=Buffer.from(result.image,"base64");if(!image.length||image.length>MAX_IMAGE)throw new Error("invalid_image");await c.telegram.withClient(async client=>{const {CustomFile}=await import("teleproto/client/uploads.js");const raw=message.raw as Api.Message;if(!raw?.peerId)throw new Error("missing_peer");await client.sendFile(raw.peerId,{file:new CustomFile(`codex-image-${Date.now()}.png`,image.length,"",image),caption:`<b>提示词：</b>\n<blockquote expandable>${esc(prompt)}</blockquote>${result.revised?`\n<b>修订提示词：</b>\n<blockquote expandable>${esc(result.revised)}</blockquote>`:""}`,parseMode:"html",replyTo:ref?.reply.id??message.id});if(typeof raw.delete==="function")await raw.delete({revoke:true});});}catch{if(!c.signal.aborted){c.log.error("codex_image_failed");await c.telegram.edit(message,"图片生成失败，请检查凭据、网络和服务状态");}}
    },
  };
  return definePlugin({apiVersion:STRUCTURED_PLUGIN_API_VERSION,id:"codex_image",description:"通过 Codex 图片工具生成或编辑图片",
    renderHelp: prefix => renderCommandHelp("cximg", cximg, {prefix, title: "🎨 Codex 图片生成"}),
    commands:{cximg},
    settings:c=>({id:"codex_image",title:"Codex 图片生成",description:"Codex 图片生成配置",category:"插件配置",icon:"🎨",getSchema:()=>[{key:"accessToken",label:"Access Token",type:"password",secret:true},{key:"model",label:"模型",type:"string",required:true},{key:"maxWaitMs",label:"最大等待时间（毫秒）",type:"number",min:60000,max:1800000}],getValues:()=>store(c).read(),setValues:async patch=>{await store(c).update(v=>({...v,accessToken:typeof patch.accessToken==="string"?patch.accessToken.trim():v.accessToken,model:typeof patch.model==="string"&&patch.model.trim()?patch.model.trim():v.model,maxWaitMs:typeof patch.maxWaitMs==="number"?Math.max(60000,Math.min(1800000,patch.maxWaitMs)):v.maxWaitMs}));}}),
    setup:migrate});
}
