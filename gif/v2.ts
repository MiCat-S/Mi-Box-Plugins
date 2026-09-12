import {open,stat,type FileHandle} from "node:fs/promises";
import path from "node:path";
import {STRUCTURED_PLUGIN_API_VERSION,definePlugin,renderCommandHelp,type CommandDefinition,type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";

type Config={schemaVersion:1;maxFileSize:number;maxDuration:number;maxWidth:number;maxHeight:number;quality:number};
const defaults:Config={schemaVersion:1,maxFileSize:50,maxDuration:10,maxWidth:512,maxHeight:512,quality:15};
const FFMPEG=["/usr/bin/ffmpeg","/usr/local/bin/ffmpeg","/opt/homebrew/bin/ffmpeg"] as const;
const FFPROBE=["/usr/bin/ffprobe","/usr/local/bin/ffprobe","/opt/homebrew/bin/ffprobe"] as const;
const EMOJI=["😀","😂","😊","😎","😍","🤔","🙄","😡","😭","🥳","🤩","🐶","🐱","🐼","🔥","✨"] as const;
const MAX_OUTPUT_BYTES=256*1024,MAX_WORK_OUTPUT_BYTES=2*1024*1024;
const store=(context:PluginContext)=>context.storage.json<Config>("config.json",defaults);
const integer=(value:unknown,fallback:number,minimum:number,maximum:number)=>Number.isInteger(value)&&Number(value)>=minimum&&Number(value)<=maximum?Number(value):fallback;
const normalize=(value:Record<string,unknown>):Config=>({schemaVersion:1,maxFileSize:integer(value.maxFileSize,defaults.maxFileSize,1,50),
  maxDuration:integer(value.maxDuration,defaults.maxDuration,1,60),maxWidth:integer(value.maxWidth,defaults.maxWidth,100,512),
  maxHeight:integer(value.maxHeight,defaults.maxHeight,100,512),quality:integer(value.quality,defaults.quality,1,31)});
class GifError extends Error {}

async function writeAll(handle:FileHandle,chunk:Uint8Array):Promise<void>{let offset=0;while(offset<chunk.byteLength){
  const{bytesWritten}=await handle.write(chunk,offset,chunk.byteLength-offset,null);if(bytesWritten<=0)throw new GifError("媒体写入失败");offset+=bytesWritten;
}}

function document(raw:any):any{return raw?.document??raw?.media?.document;}
function declaredSize(raw:any):bigint|undefined{const value=document(raw)?.size;if(value===undefined||value===null)return;try{return BigInt(String(value));}catch{return;}}
function declaredDuration(raw:any):number{
  const attribute=(document(raw)?.attributes??[]).find((value:any)=>value?.className==="DocumentAttributeVideo"||typeof value?.duration==="number");
  return Number.isFinite(Number(attribute?.duration))?Math.max(0,Number(attribute.duration)):0;
}
function supported(raw:any):boolean{
  if(!raw?.media)return false;
  const mime=String(document(raw)?.mimeType??"").toLowerCase();
  if(mime==="image/gif"||mime.startsWith("video/"))return true;
  const name=String((document(raw)?.attributes??[]).find((value:any)=>value?.className==="DocumentAttributeFilename")?.fileName??"").toLowerCase();
  return [".gif",".mp4",".avi",".mov",".webm",".mkv",".flv",".wmv",".3gp"].some(extension=>name.endsWith(extension));
}

async function download(context:PluginContext,raw:any,target:string,maximum:number,signal:AbortSignal):Promise<void>{
  const size=declaredSize(raw);if(size!==undefined&&size>BigInt(maximum))throw new GifError("文件超过配置上限");
  await context.telegram.withClient(async client=>{
    const handle=await open(target,"wx",0o600);let total=0;
    try{
      for await(const chunk of client.iterDownload(raw.media,{requestSize:512*1024})){
        signal.throwIfAborted();total+=chunk.length;if(total>maximum)throw new GifError("文件超过配置上限");await writeAll(handle,chunk);
      }
    }finally{await handle.close();}
    if(!total)throw new GifError("媒体下载为空");
  });
}

async function helper(context:PluginContext,candidates:readonly string[],args:readonly string[],options:{signal:AbortSignal;timeoutMs:number;maxOutputBytes:number;cwd:string}){
  for(const command of candidates){
    try{return await context.processes.run(command,args,options);}
    catch(error){options.signal.throwIfAborted();if((error as {code?:unknown})?.code!=="SPAWN_FAILED")throw error;}
  }
  throw new GifError("服务器未安装 FFmpeg/FFprobe");
}

type Probe={duration:number;width:number;height:number};
async function probe(context:PluginContext,input:string,signal:AbortSignal,cwd:string):Promise<Probe>{
  const result=await helper(context,FFPROBE,["-v","error","-protocol_whitelist","file","-select_streams","v:0","-show_entries","stream=width,height:format=duration","-of","json",input],{signal,timeoutMs:30_000,maxOutputBytes:4096,cwd});
  let decoded:any;try{decoded=JSON.parse(result.stdout.toString("utf8"));}catch{throw new GifError("无法读取媒体信息");}
  const duration=Number(decoded?.format?.duration),width=Number(decoded?.streams?.[0]?.width),height=Number(decoded?.streams?.[0]?.height);
  if(!Number.isFinite(duration)||duration<=0||duration>86_400||!Number.isInteger(width)||width<=0||!Number.isInteger(height)||height<=0)throw new GifError("无法读取媒体信息");
  return{duration,width,height};
}

const ffmpegArgs=(input:string,output:string,config:Config,low:boolean)=>["-nostdin","-y","-i",input,"-t",String(config.maxDuration),
  "-vf",`fps=30,scale=${low?Math.min(320,config.maxWidth):config.maxWidth}:${low?Math.min(320,config.maxHeight):config.maxHeight}:force_original_aspect_ratio=decrease,format=yuva420p`,
  "-an","-c:v","libvpx-vp9","-b:v","0","-crf",String(low?Math.min(63,config.quality+12):config.quality),"-pix_fmt","yuva420p","-auto-alt-ref","0","-f","webm","-fs",String(MAX_WORK_OUTPUT_BYTES),output];

async function convert(context:PluginContext,raw:any,config:Config,peer:any,replyTo:number|undefined):Promise<void>{
  await context.files.withTemp(async(directory,signal)=>{
    const input=path.join(directory,"input-media"),output=path.join(directory,"sticker.webm");
    await download(context,raw,input,config.maxFileSize*1024*1024,signal);
    const inputInfo=await probe(context,input,signal,directory),seconds=inputInfo.duration;
    if(seconds>config.maxDuration+0.05)throw new GifError(`媒体时长超过 ${config.maxDuration} 秒`);
    const argumentsFor=(low:boolean)=>{const args=ffmpegArgs(input,output,config,low);args.splice(2,0,"-protocol_whitelist","file");return args;};
    await helper(context,FFMPEG,argumentsFor(false),{signal,timeoutMs:180_000,maxOutputBytes:MAX_OUTPUT_BYTES,cwd:directory});
    let info=await stat(output);if(!info.isFile()||!info.size)throw new GifError("转换未生成输出");
    if(info.size>MAX_OUTPUT_BYTES){await helper(context,FFMPEG,argumentsFor(true),{signal,timeoutMs:180_000,maxOutputBytes:MAX_OUTPUT_BYTES,cwd:directory});info=await stat(output);}
    if(!info.isFile()||!info.size||info.size>MAX_OUTPUT_BYTES)throw new GifError("输出超过 256 KiB");
    const outputInfo=await probe(context,output,signal,directory);
    if(outputInfo.width>512||outputInfo.height>512)throw new GifError("输出尺寸超过 512 像素");
    await context.telegram.withClient(async client=>{const {Api}=await import("teleproto");
      await client.sendFile(peer,{file:output,forceDocument:false,replyTo,attributes:[
        new Api.DocumentAttributeVideo({duration:Math.max(1,Math.ceil(outputInfo.duration)),w:outputInfo.width,h:outputInfo.height,supportsStreaming:false,roundMessage:false}),
        new Api.DocumentAttributeAnimated(),new Api.DocumentAttributeSticker({alt:EMOJI[Math.floor(Math.random()*EMOJI.length)]!,stickerset:new Api.InputStickerSetEmpty()}),
        new Api.DocumentAttributeFilename({fileName:"sticker.webm"})]});
    });
  });
}

export default function createGif(){
  const clear={description:"确认临时目录状态",args:"",aliases:["c"],examples:[{args:"clear"}],async handle(invocation:any,context:PluginContext){await context.telegram.edit(invocation.message,"临时文件由运行时按任务隔离，并在任务结束或取消后自动清理");}};
  const command:CommandDefinition={description:"将回复的 GIF 或短视频转换为动态贴纸",helpArgs:["help","h"],args:"",arguments:[{name:"回复媒体",required:true,description:"回复 GIF 或视频后运行"}],examples:[{args:"",description:"回复 GIF 或视频"},{args:"clear"}],subcommandsCaseSensitive:false,subcommands:{clear},
    help:[{heading:"输入：",body:"支持 GIF 和常见视频文档；文件上限默认 50 MiB、时长上限默认 10 秒，可在设置中下调或调整。超限输入会拒绝，不会静默截断。"},{heading:"输出：",body:"使用 FFmpeg/FFprobe 生成 VP9 WebM 动态贴纸，最大 512×512、256 KiB。服务器须在受支持的绝对路径安装 FFmpeg 与 FFprobe。"},{heading:"生命周期：",body:"下载、探测、转换和临时文件均由当前插件任务管理；卸载或取消会终止任务，临时目录在任务结束后清理。<code>{prefix}gif clear</code> 可查看该行为。"}],
    async handle(invocation,context){
      if(invocation.message.replyToId===undefined){await context.telegram.edit(invocation.message,renderCommandHelp("gif",command,{prefix:invocation.prefix,title:"🎞️ GIF/视频转贴纸"}),{parseMode:"html"});return;}
      try{
        const reply=await context.telegram.getReply(invocation.message),source=reply?.raw as ApiTypes.Message|undefined,raw=invocation.message.raw as ApiTypes.Message|undefined;
        if(!source||!supported(source))throw new GifError("请回复 GIF 或视频");if(!raw?.peerId)throw new GifError("无法读取当前会话");
        const config=normalize(await store(context).read());const stated=declaredDuration(source);if(stated>config.maxDuration)throw new GifError(`媒体时长超过 ${config.maxDuration} 秒`);
        await context.telegram.edit(invocation.message,"正在下载并转换动态贴纸…");await convert(context,source,config,raw.peerId,reply?.id);
        if(typeof (raw as any).delete==="function"){try{await (raw as any).delete({revoke:true});}catch{if(!context.signal.aborted){context.log.info("gif_receipt_cleanup_failed");try{await context.telegram.edit(invocation.message,"动态贴纸转换完成，但命令消息清理失败");}catch{}}}}
        else await context.telegram.edit(invocation.message,"动态贴纸转换完成");
      }catch(error){if(context.signal.aborted)return;context.log.error("gif_failed");await context.telegram.edit(invocation.message,`转换失败：${error instanceof GifError?error.message:"请检查媒体格式和 FFmpeg"}`);}
    }};
  return definePlugin({apiVersion:STRUCTURED_PLUGIN_API_VERSION,id:"gif",description:"使用受管 FFmpeg 将 GIF 或短视频转换为动态贴纸",
    resources:{processes:{concurrency:1,queueCapacity:1,timeoutMs:180_000,maxOutputBytes:256*1024}},renderHelp:prefix=>renderCommandHelp("gif",command,{prefix,title:"🎞️ GIF/视频转贴纸"}),commands:{gif:command},
    settings:context=>({id:"gif",title:"GIF 转换",description:"视频/GIF 转动态贴纸限制",category:"插件配置",icon:"🎞️",getSchema:()=>[
      {key:"maxFileSize",label:"最大文件大小 (MiB)",type:"number",min:1,max:50},{key:"maxDuration",label:"最大时长 (秒)",type:"number",min:1,max:60},
      {key:"maxWidth",label:"最大宽度",type:"number",min:100,max:512},{key:"maxHeight",label:"最大高度",type:"number",min:100,max:512},{key:"quality",label:"VP9 CRF",type:"number",min:1,max:31}],
      async getValues(){return normalize(await store(context).read());},async setValues(patch){await store(context).update(value=>normalize({...value,...patch}));}}),
    async setup(context){await store(context).update(value=>normalize(value));}});
}
