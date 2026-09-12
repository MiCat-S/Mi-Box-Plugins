import {STRUCTURED_PLUGIN_API_VERSION,definePlugin,renderCommandHelp,type CommandDefinition,type PluginContext,type SubcommandDefinition} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";
import type {OverlayOptions} from "sharp";
import {DEFAULT_CATALOG_URL,loadCatalog,readBytes,sourceURL,type Catalog,type Entry,type Role} from "./v2/catalog";

type State={schemaVersion:1;sourceUrl:string};
const defaults:State={schemaVersion:1,sourceUrl:DEFAULT_CATALOG_URL};
const MAX_ASSET=8*1024*1024,MAX_CACHE=48*1024*1024,MAX_MEDIA=8*1024*1024,MAX_OUTPUT=512*1024;
const MAX_IMAGE_PIXELS=16_777_216;
const escape=(value:unknown)=>String(value??"").replace(/[&<>"']/g,character=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[character]!);
const store=(context:PluginContext)=>context.storage.json<State>("config.json",defaults);
const normalize=(value:Record<string,unknown>):State=>({schemaVersion:1,sourceUrl:sourceURL(typeof value.sourceUrl==="string"?value.sourceUrl:DEFAULT_CATALOG_URL).href});
const boundedSharp=(sharp:typeof import("sharp"),input:Buffer)=>sharp(input,{limitInputPixels:MAX_IMAGE_PIXELS,failOn:"error"});

async function replyMedia(context:PluginContext,message:any):Promise<{reply:any;data:Buffer}> {
  const reply=await context.telegram.getReply(message),raw=reply?.raw as any;
  if(!raw?.media)throw new Error("请回复图片或贴纸消息");
  const mime=String(raw.document?.mimeType??raw.media?.document?.mimeType??(raw.photo||raw.media?.photo?"image/jpeg":""));
  if(!mime.startsWith("image/")&&mime!=="video/webm")throw new Error("回复内容不是可读取的图片");
  const declared=raw.document?.size??raw.media?.document?.size;
  if(declared!==undefined&&BigInt(String(declared))>BigInt(MAX_MEDIA))throw new Error("图片超过 8 MiB");
  const data=await context.telegram.withClient(async(client,signal)=>{
    const chunks:Buffer[]=[];let total=0;
    for await(const chunk of client.iterDownload(raw.media,{requestSize:512*1024})){
      signal.throwIfAborted();total+=chunk.length;if(total>MAX_MEDIA)throw new Error("图片超过 8 MiB");chunks.push(Buffer.from(chunk));
    }
    if(!total)throw new Error("图片下载为空");return Buffer.concat(chunks,total);
  });
  return{reply,data};
}

async function clientProfile(client:any,entity:any,signal:AbortSignal):Promise<Buffer>{
  const data=await client.downloadProfilePhoto(entity,{isBig:false,signal});
  if(!Buffer.isBuffer(data)||!data.length||data.length>2*1024*1024)throw new Error("无法获取头像");
  return data;
}
async function profile(context:PluginContext,entity:any):Promise<Buffer>{
  return context.telegram.withClient((client,signal)=>clientProfile(client,entity,signal));
}

async function roleOverlay(sharp:typeof import("sharp"),asset:(url:string)=>Promise<Buffer>,role:Role,avatar:Buffer,
  canvasWidth:number,canvasHeight:number):Promise<OverlayOptions|undefined>{
  const mask=await asset(role.mask),meta=await boundedSharp(sharp,mask).metadata(),width=meta.width??0,height=meta.height??0;
  if(!width||!height||width>2048||height>2048)throw new Error("遮罩尺寸无效");
  let operation=boundedSharp(sharp,avatar).resize(width,height,{fit:"cover"});
  if(role.flip)operation=operation.flop();
  let image=await operation.png().toBuffer();
  if(role.rotate)image=await sharp(image).rotate(role.rotate,{background:{r:0,g:0,b:0,alpha:0}}).resize(width,height,{fit:"cover"}).png().toBuffer();
  if(role.brightness!==1)image=await sharp(image).modulate({brightness:role.brightness}).png().toBuffer();
  image=await sharp(image).composite([{input:mask,blend:"dest-in"}]).png().toBuffer();
  const left=Math.trunc(role.x),top=Math.trunc(role.y),cropLeft=Math.max(0,-left),cropTop=Math.max(0,-top);
  const visibleWidth=Math.min(width-cropLeft,canvasWidth-Math.max(0,left)),visibleHeight=Math.min(height-cropTop,canvasHeight-Math.max(0,top));
  if(visibleWidth<=0||visibleHeight<=0)return;
  if(cropLeft||cropTop||visibleWidth!==width||visibleHeight!==height)image=await sharp(image).extract({left:cropLeft,top:cropTop,width:visibleWidth,height:visibleHeight}).png().toBuffer();
  return{input:image,left:Math.max(0,left),top:Math.max(0,top)};
}

async function render(entry:Entry,target:Buffer,self:Buffer|undefined,asset:(url:string)=>Promise<Buffer>):Promise<Buffer>{
  const {default:sharp}=await import("sharp");
  if(entry.stamp){
    const config=entry.stamp,base=await boundedSharp(sharp,target).resize(config.size,config.size,{fit:"cover"}).png().toBuffer();
    const stamp=await boundedSharp(sharp,await asset(entry.url)).resize({width:Math.round(config.size*config.scale)})
      .rotate(config.rotate,{background:{r:0,g:0,b:0,alpha:0}}).ensureAlpha().linear([1,1,1,config.opacity],[0,0,0,0])
      .resize({width:config.size,height:config.size,fit:"inside"}).png().toBuffer();
    return sharp(base).composite([{input:stamp,gravity:"center"}]).webp({quality:90}).toBuffer();
  }
  const base=await asset(entry.url),metadata=await boundedSharp(sharp,base).metadata(),width=metadata.width??0,height=metadata.height??0;
  if(!width||!height||width>4096||height>4096||width*height>16_000_000)throw new Error("模板尺寸无效");
  const overlays:OverlayOptions[]=[];
  if(entry.you){const item=await roleOverlay(sharp,asset,entry.you,target,width,height);if(item)overlays.push(item);}
  if(entry.me){if(!self)throw new Error("无法获取自己的头像");const item=await roleOverlay(sharp,asset,entry.me,self,width,height);if(item)overlays.push(item);}
  return boundedSharp(sharp,base).composite(overlays).resize({width:512,height:512,fit:"inside",withoutEnlargement:true}).webp({quality:92}).toBuffer();
}

export default function createEat(){
  let loaded:{sourceUrl:string;resources:Catalog}|undefined;
  const cache=new Map<string,Buffer>();let cacheBytes=0;
  const asset=async(context:PluginContext,url:string)=>{
    const saved=cache.get(url);if(saved)return saved;
    const bytes=await readBytes(context,new URL(url),MAX_ASSET);cache.set(url,bytes);cacheBytes+=bytes.length;
    while(cache.size>64||cacheBytes>MAX_CACHE){const first=cache.entries().next().value as [string,Buffer]|undefined;if(!first)break;cache.delete(first[0]);cacheBytes-=first[1].length;}
    return bytes;
  };
  const catalog=async(context:PluginContext)=>{
    const state=normalize(await store(context).read());
    if(loaded?.sourceUrl===state.sourceUrl)return loaded.resources;
    loaded=await loadCatalog(context,state.sourceUrl);return loaded.resources;
  };
  const list=async(invocation:any,context:PluginContext)=>{
    const current=await catalog(context),lines=Object.entries(current).sort(([a],[b])=>a.localeCompare(b,"en"))
      .map(([key,value])=>`• <code>${escape(key)}</code> - ${escape(value.name)}`);
    await context.telegram.edit(invocation.message,`<b>吃表情模板</b>\n<code>${escape(invocation.prefix)}eat 名称</code>（需回复目标）\n\n${lines.join("\n")}`,{parseMode:"html"});
  };
  const guarded=(operation:SubcommandDefinition["handle"]):SubcommandDefinition["handle"]=>async(invocation,context)=>{
    try{await operation(invocation,context);}catch(error){if(context.signal.aborted)return;context.log.error("eat_failed");await context.telegram.edit(invocation.message,`生成失败：${escape((error as Error)?.message||"请检查网络、素材和 Sharp")}`,{parseMode:"html"});}
  };
  const set:SubcommandDefinition={description:"更新远程模板配置",args:"[GitHub raw URL]",arguments:[{name:"GitHub raw URL",description:"省略时恢复默认配置"}],examples:[{args:"set"},{args:`set ${DEFAULT_CATALOG_URL}`}],handle:guarded(async(invocation,context)=>{
    const next=await loadCatalog(context,invocation.args[0]||DEFAULT_CATALOG_URL);
    await store(context).update(()=>({schemaVersion:1,sourceUrl:next.sourceUrl}));loaded=next;cache.clear();cacheBytes=0;
    await context.telegram.edit(invocation.message,`配置已更新，共 ${Object.keys(next.resources).length} 个模板`);
  })};
  const show:SubcommandDefinition={description:"查看模板列表",args:"",aliases:["ls"],examples:[{args:"list"}],handle:guarded(list)};
  const make=(media:boolean):CommandDefinition=>({description:media?"使用回复图片生成表情":"使用双方头像生成表情",helpArgs:["help","h"],args:"[名称]",
    arguments:[{name:"名称",description:"模板名；省略时随机选择"}],examples:[{args:""},{args:"at"},{args:"list"}],subcommandsCaseSensitive:false,
    subcommands:{list:show,set},help:[{heading:"用法：",body:media?"回复图片或静态贴纸后，用 <code>{prefix}eat2 [名称]</code> 生成；不写名称时随机。":"回复目标用户消息后，用 <code>{prefix}eat [名称]</code> 生成；包含 me 区域的模板还会读取当前账号头像。不写名称时随机。"},{heading:"配置与限制：",body:"<code>{prefix}eat set [GitHub raw URL]</code> 会先下载并校验配置再切换。配置与素材仅允许 GitHub HTTPS raw 地址；图片下载、缓存、尺寸和输出均有固定上限。"}],
    async handle(invocation,context){
      if(invocation.message.replyToId===undefined){await list(invocation,context);return;}
      await guarded(async(i,c)=>{
        const current=await catalog(c),key=(i.args[0]||Object.keys(current)[Math.floor(Math.random()*Object.keys(current).length)]||"").toLowerCase(),entry=current[key];
        if(!entry){await c.telegram.edit(i.message,`未找到模板：<code>${escape(key)}</code>`,{parseMode:"html"});return;}
        const reply=await c.telegram.getReply(i.message),replyRaw=reply?.raw as any,commandRaw=i.message.raw as ApiTypes.Message|undefined;
        if(!replyRaw||!commandRaw?.peerId)throw new Error("无法读取回复消息");
        await c.telegram.edit(i.message,`正在生成：${escape(entry.name)}`,{parseMode:"html"});
        const target=media?(await replyMedia(c,i.message)).data:await profile(c,replyRaw.sender??replyRaw.senderId??reply?.senderId);
        const self=entry.me?await c.telegram.withClient(async(client,signal)=>clientProfile(client,await client.getMe(),signal)):undefined;
        let output=await render(entry,target,self,url=>asset(c,url));
        if(output.length>MAX_OUTPUT){const {default:sharp}=await import("sharp");output=await sharp(output).webp({quality:72,effort:6}).toBuffer();}
        if(!output.length||output.length>MAX_OUTPUT)throw new Error("输出超过 512 KiB");
        await c.telegram.withClient(async client=>{const {Api}=await import("teleproto"),{CustomFile}=await import("teleproto/client/uploads.js"),metadata=await (await import("sharp")).default(output).metadata();
          await client.sendFile(commandRaw.peerId!,{file:new CustomFile("eat.webp",output.length,"",output),forceDocument:false,replyTo:i.message.replyToId,
            attributes:[new Api.DocumentAttributeSticker({alt:entry.name.slice(0,32),stickerset:new Api.InputStickerSetEmpty()}),new Api.DocumentAttributeImageSize({w:metadata.width??512,h:metadata.height??512}),new Api.DocumentAttributeFilename({fileName:"eat.webp"})]});
          if(typeof (commandRaw as any).delete==="function"){try{await (commandRaw as any).delete({revoke:true});}
            catch{if(!c.signal.aborted)c.log.info("eat_receipt_cleanup_failed");}}});
      })(invocation,context);
    }});
  const eat=make(false),eat2=make(true);
  const renderGuide=(prefix:string)=>[renderCommandHelp("eat",eat,{prefix,title:"😋 吃表情"}),renderCommandHelp("eat2",eat2,{prefix,title:""})].join("\n\n");
  return definePlugin({apiVersion:STRUCTURED_PLUGIN_API_VERSION,id:"eat",description:"将头像或回复图片合成表情贴纸",renderHelp:renderGuide,commands:{eat,eat2},
    settings:context=>({id:"eat",title:"吃表情",description:"远程模板配置",category:"插件配置",icon:"😋",getSchema:()=>[{key:"sourceUrl",label:"模板配置 URL",type:"string",required:true,description:"仅支持 GitHub HTTPS raw 文件"}],
      async getValues(){return normalize(await store(context).read());},async setValues(patch){const current=normalize(await store(context).read()),next=await loadCatalog(context,typeof patch.sourceUrl==="string"?patch.sourceUrl:current.sourceUrl);await store(context).update(()=>({schemaVersion:1,sourceUrl:next.sourceUrl}));loaded=next;cache.clear();cacheBytes=0;}}),
    async setup(context){await store(context).update(value=>normalize(value));},cleanup(){loaded=undefined;cache.clear();cacheBytes=0;}});
}
