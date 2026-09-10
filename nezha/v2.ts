import {generateChartConfig} from "./v2/chart";
import {createHmac} from "node:crypto";
import path from "node:path";
import {open,type FileHandle} from "node:fs/promises";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, type CommandInvocation, definePlugin,ui,type MessageEnvelope,type PluginContext} from "telebox/sdk";
type Config={schemaVersion:1;url:string;secret:string;serviceMonitor:boolean;legacyImported:boolean;[key:string]:unknown};
type Server={id:number;name:string;display_index?:number;last_active?:string;host?:any;state?:any;geoip?:any};
const defaults:Config={schemaVersion:1,url:"",secret:"",serviceMonitor:true,legacyImported:false};
const store=(c:PluginContext)=>c.storage.json<Config>("config-v2.json",defaults);
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[x]!);
function root(value:string){const u=new URL(value);if(!/^https?:$/.test(u.protocol)||u.username||u.password)throw new Error("面板地址无效");u.pathname=u.pathname.replace(/\/+$/,"");u.search="";u.hash="";return u;}
const b64=(v:string)=>Buffer.from(v).toString("base64url");
function jwt(secret:string){const now=Math.floor(Date.now()/1000),h=b64(JSON.stringify({alg:"HS256",typ:"JWT"})),p=b64(JSON.stringify({user_id:"1",orig_iat:now,exp:now+3600,ip:""}));return`${h}.${p}.${createHmac("sha256",secret).update(`${h}.${p}`).digest("base64url")}`;}
async function get(c:PluginContext,config:Config,endpoint:string){const u=root(config.url);u.pathname=`${u.pathname}${endpoint}`;return c.http.withResponse(u,{headers:{cookie:`nz-jwt=${jwt(config.secret)}`,"user-agent":"MiBot-Nezha/2",accept:"application/json"}},async(r,s)=>{const reader=r.body?.getReader();if(!reader)throw new Error("哪吒返回空响应");const chunks:Buffer[]=[];let total=0;try{for(;;){s.throwIfAborted();const x=await reader.read();if(x.done)break;total+=x.value.length;if(total>2*1024*1024)throw new Error("哪吒响应过大");chunks.push(Buffer.from(x.value));}}finally{reader.releaseLock();}let data:any;try{data=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new Error("哪吒返回无效 JSON");}if(!r.ok)throw new Error(`HTTP ${r.status}`);if(data?.success!==true&&!Array.isArray(data))throw new Error("哪吒响应结构异常");return Array.isArray(data)?data:data.data;},{timeoutMs:15_000,redirects:{allowedHosts:[u.hostname],maxRedirects:2}});}
const bytes=(n:number)=>{if(!Number.isFinite(n)||n<=0)return"0 B";const u=["B","KB","MB","GB","TB"],i=Math.min(4,Math.floor(Math.log(n)/Math.log(1024)));return`${(n/1024**i).toFixed(2)} ${u[i]}`;};
const online=(s:Server)=>Boolean(s.last_active&&Date.now()-new Date(s.last_active).getTime()<60_000);
const SERVICE_CONCURRENCY=6;
async function mapLimit<T,R>(items:readonly T[],limit:number,worker:(item:T)=>Promise<R>,signal:AbortSignal):Promise<R[]>{const results=new Array<R>(items.length);let next=0;const size=Math.max(1,Math.min(limit,items.length));await Promise.all(Array.from({length:size},async()=>{for(;;){const index=next++;if(index>=items.length)return;signal.throwIfAborted();results[index]=await worker(items[index]!);}}));return results;}
function row(s:Server,services?:Map<string,number>){const state=s.state??{},host=s.host??{},pct=(a:number,b:number)=>b?Math.min(100,a/b*100).toFixed(1):"0.0";const monitors=services?.size?`\n📶 ${[...services].map(([n,d])=>`${esc(n)}:${d.toFixed(1)}ms`).join(" | ")}`:"";if(!online(s))return`🔴 <b>${esc(s.name)}</b> <code>#${s.id}</code>${monitors}`;return`🟢 <b>${esc(s.name)}</b> <code>#${s.id}</code>${monitors}\n<blockquote>CPU ${Number(state.cpu??0).toFixed(1)}% · 内存 ${pct(state.mem_used,host.mem_total)}% · 硬盘 ${pct(state.disk_used,host.disk_total)}%\n网络 ↑${bytes(state.net_out_speed??0)}/s ↓${bytes(state.net_in_speed??0)}/s · 运行 ${Math.floor((state.uptime??0)/86400)} 天</blockquote>`;}
async function services(c:PluginContext,config:Config,id:number){const result=new Map<string,number>();try{const data=await get(c,config,`/api/v1/service/${id}`);if(Array.isArray(data))for(const x of data){const delay=Array.isArray(x?.avg_delay)?Number(x.avg_delay.at(-1)):NaN;if(typeof x?.monitor_name==="string"&&Number.isFinite(delay))result.set(x.monitor_name,delay);}}catch{}return result;}
async function list(c:PluginContext,config:Config){const data=await get(c,config,"/api/v1/server");if(!Array.isArray(data))throw new Error("服务器列表结构异常");const servers=data.filter((x:any)=>Number.isSafeInteger(x?.id)&&typeof x?.name==="string") as Server[];const maps=new Map<number,Map<string,number>>();if(config.serviceMonitor){const monitored=servers.filter(online);const results=await mapLimit(monitored,SERVICE_CONCURRENCY,s=>services(c,config,s.id),c.signal);monitored.forEach((s,index)=>maps.set(s.id,results[index]!));}servers.sort((a,b)=>Number(online(b))-Number(online(a))+(a.display_index??0)-(b.display_index??0));const count=servers.filter(online).length;const pages=await ui.renderDocument({title:"📊 哪吒监控",subtitle:`${count}/${servers.length} 在线 · 服务监控${config.serviceMonitor?"开":"关"}`,sections:[ui.section(undefined,servers.map(s=>row(s,maps.get(s.id)) as unknown as ui.Html))]},ui.PAGE_LABEL_RESERVE);return pages.map((page,index)=>page+ui.pageLabel(index,pages.length));}
async function chart(c:PluginContext,m:MessageEnvelope,config:Config,target:string){
  const all=await get(c,config,"/api/v1/server");
  if(!Array.isArray(all))throw new Error("服务器列表结构异常");
  const server=(all as Server[]).find(s=>String(s.id)===target||s.name===target);
  if(!server)throw new Error("未找到服务器");
  const monitor=await get(c,config,`/api/v1/service/${server.id}`);
  if(!Array.isArray(monitor)||!monitor.length)throw new Error("没有服务监控数据");
  const body={chart:generateChartConfig(monitor,server.name),width:800,height:400,backgroundColor:"black",format:"png"};
  const u=new URL("https://quickchart.io/chart");
  await c.files.withTemp(async(dir,signal)=>{
    const file=path.join(dir,"chart.png");
    await c.http.withResponse(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)},async(r,s)=>{
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const reader=r.body?.getReader();
      if(!reader)throw new Error("图表响应为空");
      let handle:FileHandle|undefined,total=0,finished=false;
      try{
        handle=await open(file,"wx");
        for(;;){
          s.throwIfAborted();
          const x=await reader.read();
          if(x.done){finished=true;break;}
          total+=x.value.length;
          if(total>4*1024*1024)throw new Error("图表过大");
          await handle.writeFile(x.value);
        }
      }finally{
        try{await handle?.close();}
        finally{try{if(!finished)await reader.cancel();}finally{reader.releaseLock();}}
      }
    },{timeoutMs:30_000,redirects:{allowedHosts:["quickchart.io"],maxRedirects:1}});
    signal.throwIfAborted();
    await c.telegram.withClient(client=>client.sendFile((m.raw as any)?.peerId??m.chatId,{file,caption:`${server.name} 服务延迟`,replyTo:m.id}));
  });
}
async function migrate(c:PluginContext){const current=await store(c).read();if(current.legacyImported)return;let legacy:any={};try{legacy=JSON.parse(await (await import("node:fs/promises")).readFile(c.files.dataPath("config.json"),"utf8"));}catch{}await store(c).update(v=>({...v,url:v.url||String(legacy.url??""),secret:v.secret||String(legacy.secret??""),serviceMonitor:typeof legacy.serviceMonitor==="boolean"?legacy.serviceMonitor:v.serviceMonitor,legacyImported:true}));}
const guarded = (operation: CommandDefinition["handle"]): CommandDefinition["handle"] => async (i, c) => {
  try { await operation(i, c); }
  catch(e) { if (!c.signal.aborted) await c.telegram.edit(i.message, `❌ ${esc(e instanceof Error ? e.message : "哪吒请求失败")}`, {parseMode: "html"}); }
};
const configured = (operation: (i: CommandInvocation, c: PluginContext, config: Config) => Promise<void>): CommandDefinition["handle"] => guarded(async (i, c) => {
  const config = await store(c).read();
  if (!config.url || !config.secret) throw new Error("请先配置哪吒地址和 JWT Secret");
  await operation(i, c, config);
});
const service = (enabled: boolean): CommandDefinition["handle"] => configured(async (i, c) => {
  await store(c).update(v => ({...v, serviceMonitor: enabled}));
  await c.telegram.edit(i.message, "服务监控设置已更新。");
});
const command: CommandDefinition = {
  description: "查询或配置哪吒监控", helpArgs: ["help", "h"], args: "", subcommandsCaseSensitive: false,
  examples: [{args: "", description: "查看全部服务器，在线服务器优先，长列表自动分页"}],
  subcommands: {
    set: {description: "验证并保存面板连接配置", args: "面板地址 JWT_SECRET", examples: [{args: "set https://nezha.example.com your_jwt_secret"}],
      help: [{heading: "首次配置：", body: "在收藏夹设置面板地址与面板配置的 jwt_secret_key 原始值。先验证 /api/v1/server 接口，成功后保存，保留服务延迟显示开关。"}],
      async authorize(i, c) { if (i.message.saved) return true; if (!c.signal.aborted) await c.telegram.edit(i.message, "❌ 密钥配置仅限收藏夹", {parseMode: "html"}); return false; },
      handle: guarded(async (i, c) => {
        if (!i.args[0] || !i.args[1]) throw new Error("用法：nezha set URL JWT_SECRET");
        root(i.args[0]);
        const candidate = {...(await store(c).read()), url: i.args[0].replace(/\/+$/, ""), secret: i.args.slice(1).join(" ")};
        await get(c, candidate, "/api/v1/server");
        await store(c).update(v => ({...v, url: candidate.url, secret: candidate.secret}));
        await c.telegram.edit(i.message, "哪吒配置已验证并保存。");
      })},
    service: {description: "设置列表中的服务延迟显示，默认开启", subcommandsCaseSensitive: true,
      subcommands: {
        on: {description: "开启服务延迟显示", args: "", handle: service(true)},
        off: {description: "关闭服务延迟显示", args: "", handle: service(false)},
      }, examples: [{args: "service off"}],
      handle: configured(async () => { throw new Error("用法：nezha service on|off"); })},
    chart: {description: "生成指定服务器的服务延迟图表", args: "服务器名或ID", examples: [{args: "chart 1"}, {args: "chart 香港节点"}],
      help: [{heading: "图表数据：", body: "通过 QuickChart 生成图表，相关图表数据会发送到 quickchart.io。服务器须存在服务监控记录。"}],
      handle: configured(async (i, c, config) => {
        await c.telegram.edit(i.message, "正在获取哪吒监控数据…");
        if (!i.args.length) throw new Error("请提供服务器名称或 ID");
        await chart(c, i.message, config, i.args.join(" "));
      })},
  },
  help: [
    {heading: "配置与数据范围：", body: "面板使用 HTTP/HTTPS 地址，可包含部署子路径；需提供 /api/v1/server 与服务监控接口并接受 JWT 认证。连接配置在各对话间共用，也可通过插件设置填写面板地址和 JWT Secret。"},
    {heading: "常见提示：", body: "未配置时先在收藏夹完成 set；HTTP 或验证失败时检查面板地址、JWT Secret 和接口兼容性；图表缺少数据时核对服务器名/ID 与服务监控记录。"},
  ],
  handle: configured(async (i, c, config) => {
    const m = i.message;
    await c.telegram.edit(m, "正在获取哪吒监控数据…");
    const pages = await list(c, config);
    const delivery = await ui.deliverPages(pages, c.signal, (page, index) => index ? c.telegram.reply(m, page, {parseMode: "html"}) : c.telegram.edit(m, page, {parseMode: "html"}));
    if (delivery.interrupted) {
      c.log.info("pagination_delivery_interrupted", {plugin: "nezha", published: delivery.published, total: delivery.total, category: ui.deliveryErrorCategory(delivery.error)});
      if (!delivery.published) throw delivery.error;
      try { await c.telegram.reply(m, ui.interruptedNotice(delivery), {parseMode: "html"}); } catch {}
    }
  }),
};
const help = (prefix: string) => renderCommandHelp("nezha", command, {prefix, title: "📊 哪吒监控"});
export default function createNezha(){return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION,id:"nezha",description:"查询哪吒监控服务器与服务延迟",commands:{nezha: command},settings:c=>({id:"nezha",title:"哪吒监控",category:"插件配置",icon:"📊",getSchema:()=>[{key:"url",label:"面板地址",type:"string"},{key:"secret",label:"JWT Secret",type:"password",secret:true},{key:"serviceMonitor",label:"服务监控",type:"boolean"}],getValues:async()=>{const v=await store(c).read();return{url:v.url,secret:v.secret,serviceMonitor:v.serviceMonitor};},async setValues(p){await store(c).update(v=>{const url=typeof p.url==="string"?p.url:v.url;if(url)root(url);return{...v,url,secret:typeof p.secret==="string"?p.secret:v.secret,serviceMonitor:typeof p.serviceMonitor==="boolean"?p.serviceMonitor:v.serviceMonitor};});}}),setup:migrate});}
