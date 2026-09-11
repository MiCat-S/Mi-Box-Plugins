import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {readFile} from "node:fs/promises";
import type {Api} from "teleproto";

type State={schemaVersion:1;apiKey:string;maxBytes:number;importedLegacy:boolean;aiMigrated?:boolean;[key:string]:unknown};
type ImageResult={data?:Uint8Array;mimeType?:string;revisedPrompt?:string};
const DEFAULT_LIMIT=10*1024*1024,MIN_LIMIT=256*1024,MAX_LIMIT=25*1024*1024;
const defaults:State={schemaVersion:1,apiKey:"",maxBytes:DEFAULT_LIMIT,importedLegacy:true,aiMigrated:true};
const store=(c:PluginContext)=>c.storage.json<State>("config.json",defaults);
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[x]!);
const clamp=(v:unknown)=>Math.max(MIN_LIMIT,Math.min(MAX_LIMIT,Number.isFinite(Number(v))?Math.round(Number(v)):DEFAULT_LIMIT));
const size=(raw:string)=>{const m=raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(b|kb|mb)?$/);if(!m)return;return Math.round(Number(m[1])*(m[2]==="b"?1:m[2]==="kb"?1024:1048576));};
const label=(n:number)=>n>=1048576?`${+(n/1048576).toFixed(1)}MB`:n>=1024?`${+(n/1024).toFixed(1)}KB`:`${n}B`;
async function migrate(c:PluginContext){
  let current=await store(c).read();
  if(!current.importedLegacy){let source:any=current;try{source={...JSON.parse(await readFile(c.files.dataPath("config.json"),"utf8")),...current};}catch{}
    current=await store(c).update(()=>({...source,schemaVersion:1,apiKey:typeof source.apiKey==="string"?source.apiKey.trim():"",maxBytes:clamp(source.maxBytes),importedLegacy:true,aiMigrated:source.aiMigrated===true}));}
  if(current.aiMigrated)return;
  if(!current.apiKey){await store(c).update(value=>({...value,apiKey:"",aiMigrated:true}));return;}
  if(!c.services.available("ai","import_provider"))return;
  await c.services.call("ai","import_provider",{tag:"banana",url:"https://generativelanguage.googleapis.com/v1beta",key:current.apiKey,
    type:"gemini",models:{image:"gemini-3-pro-image-preview"},select:["image"]},c.signal);
  await store(c).update(value=>({...value,apiKey:"",aiMigrated:true}));
}
async function media(c:PluginContext,m:MessageEnvelope,limit:number){const reply=await c.telegram.getReply(m);if(!reply?.raw)throw new Error("reply_image_required");return c.telegram.withClient(async(client,signal)=>{const raw=reply.raw as any;let total=0;const chunks:Buffer[]=[];for await(const chunk of client.iterDownload(raw.media,{})){signal.throwIfAborted();total+=chunk.length;if(total>limit)throw new Error("image_too_large");chunks.push(Buffer.from(chunk));}if(!total)throw new Error("empty_image");const mime=raw.media?.document?.mimeType??(raw.media?.photo?"image/jpeg":"image/png");if(!String(mime).startsWith("image/"))throw new Error("reply_image_required");return{reply,buffer:Buffer.concat(chunks,total),mime:String(mime)};});}

export default function createBanana(){
  const key = async (invocation: CommandInvocation, c: PluginContext): Promise<void> => {
    await c.telegram.edit(invocation.message, `供应商、密钥和图片模型由 ai 插件统一管理，请使用 ${invocation.prefix}ai config 与 ${invocation.prefix}ai model image。`);
  };
  const limit = async (invocation: CommandInvocation, c: PluginContext): Promise<void> => {
    const state = await store(c).read();
    if (!invocation.args[0]) { await c.telegram.edit(invocation.message, `当前图片上限：${label(state.maxBytes)}`); return; }
    const parsed = invocation.args[0] === "default" ? DEFAULT_LIMIT : size(invocation.args[0]);
    if (!parsed || parsed < MIN_LIMIT || parsed > MAX_LIMIT) { await c.telegram.edit(invocation.message, `图片上限须为 ${label(MIN_LIMIT)} 至 ${label(MAX_LIMIT)}`); return; }
    await store(c).update(v => ({...v, maxBytes: parsed}));
    await c.telegram.edit(invocation.message, `图片上限已设置为 ${label(parsed)}`);
  };
  const config = async (invocation: CommandInvocation, c: PluginContext): Promise<void> => {
    await migrate(c);
    const state = await store(c).read();
    let selection="请先安装并配置 ai 插件";
    if(c.services.available("ai","selection")){const selected=await c.services.call<{image?:{tag?:string;model?:string}}>("ai","selection",null,c.signal);selection=`${selected.image?.tag||"-"} / ${selected.image?.model||"-"}`;}
    await c.telegram.edit(invocation.message, `AI：${selection}\n图片上限：${label(state.maxBytes)}`);
  };
  const edit = async (invocation: CommandInvocation, c: PluginContext): Promise<void> => {
    await migrate(c);
    const state = await store(c).read();
    if (!c.services.available("ai", "image")) { await c.telegram.edit(invocation.message, "请先安装并配置 ai 插件的图片模型"); return; }
    const prompt = invocation.args.join(" ").trim();
    if (!prompt) { await c.telegram.edit(invocation.message, `用法：回复图片并发送 ${invocation.prefix}banana <提示词>`); return; }
    try {
      const input = await media(c, invocation.message, state.maxBytes);
      await c.telegram.edit(invocation.message, "正在生成图片…");
      const images=await c.services.call<ImageResult[]>("ai","image",{prompt,input:{data:input.buffer,mimeType:input.mime}},c.signal);
      if(!images.length)throw new Error("empty_result");
      await c.telegram.withClient(async client => {
        const {CustomFile} = await import("teleproto/client/uploads.js");
        const raw = invocation.message.raw as Api.Message;
        if (!raw?.peerId) throw new Error("missing_peer");
        for (let i = 0; i < images.length; i++) {
          const out = Buffer.from(images[i].data ?? []);
          if (!out.length || out.length > MAX_LIMIT) throw new Error("invalid_image");
          await client.sendFile(raw.peerId, {file: new CustomFile(`banana-${Date.now()}-${i}.png`, out.length, "", out), caption: i === 0 ? `<b>提示：</b> ${esc(prompt)}${images[i].revisedPrompt ? `\n\n${esc(images[i].revisedPrompt)}` : ""}` : undefined, parseMode: i === 0 ? "html" : undefined, replyTo: input.reply.id});
        }
        if (typeof raw.delete === "function") await raw.delete({revoke: true});
      });
    } catch {
      if (!c.signal.aborted) { c.log.error("banana_failed"); await c.telegram.edit(invocation.message, "图片编辑失败，请检查图片、配置和服务状态"); }
    }
  };
  const banana: CommandDefinition = {
    description: "回复图片并使用统一 AI 图片模型编辑",
    ignoreEdited: true,
    args: "提示词",
    arguments: [{name: "提示词", required: true, description: "对回复图片的编辑指令"}],
    examples: [{args: "把背景换成夜晚", description: "回复一张图片后发送"}],
    subcommandsCaseSensitive: false,
    subcommands: {
      key: {description: "查看统一 AI 配置方式", args: "", handle: key},
      limit: {description: "查看或调整图片大小上限", args: "[数值/MB|default]", arguments: [{name: "数值/MB|default", description: "省略时查看当前上限；default 恢复 10MB"}], examples: [{args: "limit"}, {args: "limit 5"}, {args: "limit default"}], handle: limit},
      config: {description: "查看当前配置", args: "", examples: [{args: "config"}], handle: config},
    },
    help: [
      {heading: "说明：", body: "回复图片并附带 <code>{prefix}banana 提示词</code> 调用 ai 插件当前图片模型修改图像。供应商、密钥与模型由 ai 插件统一管理；大小上限范围为 256KB 至 25MB。"},
    ],
    handle: edit,
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "banana", description: "使用统一 AI 服务编辑图片",
    renderHelp: prefix => renderCommandHelp("banana", banana, {prefix, title: "🎯 Nano-Banana 图像编辑插件"}),
    commands: {banana}, settings: c => ({
      id: "banana", title: "Nano-Banana", description: "图片编辑限制", category: "插件配置", icon: "🍌",
      getSchema: () => [{key: "maxBytes", label: "图片大小上限（字节）", type: "number", min: MIN_LIMIT, max: MAX_LIMIT}],
      getValues: async () => ({maxBytes:(await store(c).read()).maxBytes}),
      setValues: async patch => { await store(c).update(v => ({...v, maxBytes: patch.maxBytes === undefined ? v.maxBytes : clamp(patch.maxBytes)})); },
    }), setup: migrate});
}
