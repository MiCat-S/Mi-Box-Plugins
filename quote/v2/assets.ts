import {lstat,open,rename,rm} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import type {PluginContext} from "telebox/sdk";

const LIMIT=64*1024*1024;
const ROOT="https://raw.githubusercontent.com";
const FILES=[
  ["pattern_02.png",483530,"https://raw.githubusercontent.com/LyoSU/quote-api/master/assets/pattern_02.png"],
  ["pattern_ny.png",366082,"https://raw.githubusercontent.com/LyoSU/quote-api/master/assets/pattern_ny.png"],
  ["emoji/emoji-apple-image.json",29380588,"https://raw.githubusercontent.com/LyoSU/quote-api/master/assets/emoji/emoji-apple-image.json"],
  ["emoji/emoji-google-image.json",18892340,"https://raw.githubusercontent.com/LyoSU/quote-api/master/assets/emoji/emoji-google-image.json"],
  ["emoji/emoji-twitter-image.json",14470600,"https://raw.githubusercontent.com/LyoSU/quote-api/master/assets/emoji/emoji-twitter-image.json"],
  ["emoji/emoji-joypixels-image.json",18326902,"https://raw.githubusercontent.com/LyoSU/quote-api/master/assets/emoji/emoji-joypixels-image.json"],
  ["emoji/emoji-blob-image.json",2092162,"https://raw.githubusercontent.com/LyoSU/quote-api/master/assets/emoji/emoji-blob-image.json"],
  ["NotoSansCJK-Regular.ttc",19484784,"https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTC/NotoSansCJK-Regular.ttc"],
  ["NotoSansCJK-Bold.ttc",20050760,"https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTC/NotoSansCJK-Bold.ttc"],
] as const;
async function valid(file:string){try{const info=await lstat(file);return info.isFile()&&info.size>0&&info.size<=LIMIT;}catch(error){if(error instanceof Error&&"code" in error&&error.code==="ENOENT")return false;throw error;}}
async function fetchFile(context:PluginContext,relative:string,_referenceSize:number,url:string){const target=await context.files.dataFile(relative);if(await valid(target))return;const temporary=`${target}.${randomUUID()}.tmp`;try{await context.http.withResponse(url,{method:"GET",headers:{accept:"application/octet-stream"}},async(response,signal)=>{if(!response.ok||!response.body)throw new Error("quote asset download failed");const header=response.headers.get("content-length");let announced:number|undefined;if(header!==null){announced=Number(header);if(!Number.isSafeInteger(announced)||announced<=0||announced>LIMIT)throw new Error("quote asset size mismatch");}const handle=await open(temporary,"wx",0o600),reader=response.body.getReader();let total=0,done=false,cancelPromise:Promise<void>|undefined;const cancel=()=>cancelPromise??=reader.cancel();const abort=()=>{void cancel().catch(()=>undefined);};signal.addEventListener("abort",abort,{once:true});try{for(;;){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done){done=true;break;}total+=part.value.byteLength;if(total>LIMIT)throw new Error("quote asset too large");let offset=0;while(offset<part.value.byteLength){const written=await handle.write(part.value,offset,part.value.byteLength-offset,null);signal.throwIfAborted();if(written.bytesWritten<=0)throw new Error("quote asset short write");offset+=written.bytesWritten;}}if(!total||announced!==undefined&&total!==announced)throw new Error("quote asset short download");}finally{signal.removeEventListener("abort",abort);try{if(!done)await cancel().catch(()=>undefined);}finally{try{reader.releaseLock();}finally{await handle.close();}}}},{signal:context.signal,timeoutMs:120000,denyPrivateAddresses:true,redirects:{allowedHosts:["raw.githubusercontent.com"],maxRedirects:0}});context.signal.throwIfAborted();await rename(temporary,target);}finally{await rm(temporary,{force:true});}}

export function createAssetLoader(){let pending:Promise<string>|undefined;return(context:PluginContext):Promise<string>=>{if(pending)return pending;const operation=(async()=>{for(const [name,size,url] of FILES){if(!url.startsWith(`${ROOT}/`))throw new Error("quote asset host rejected");context.signal.throwIfAborted();await fetchFile(context,name,size,url);}return context.files.dataPath();})();pending=operation;void operation.finally(()=>{if(pending===operation)pending=undefined;}).catch(()=>undefined);return operation;};}
