import {createReports} from "./v2/reports";
import {STRUCTURED_PLUGIN_API_VERSION, requireSdkFeatures, renderCommandHelp, type CommandDefinition, definePlugin,ui,type MessageEnvelope,type PluginContext} from "telebox/sdk";
requireSdkFeatures("legacySqlite");
type Config={schemaVersion:1;url:string;legacyImported:boolean;[key:string]:unknown};
const defaults:Config={schemaVersion:1,url:"",legacyImported:false};
const store=(c:PluginContext)=>c.storage.json<Config>("config-v2.json",defaults);
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[x]!);
const number=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v:0;
function base(input:string){const u=new URL(input.includes("://")?input:`https://${input}`);if(!/^https?:$/.test(u.protocol)||u.username||u.password)throw new Error("Komari 地址无效");u.pathname=u.pathname.replace(/\/+$/,"");u.search="";u.hash="";return u;}
async function get(c:PluginContext,root:URL,endpoint:string){const u=new URL(root);u.pathname=`${u.pathname}${endpoint}`;return c.http.withResponse(u,{headers:{accept:"application/json","user-agent":"MiBot-Komari/2"}},async(r,s)=>{const reader=r.body?.getReader();if(!reader)throw new Error("Komari 返回空响应");const chunks:Buffer[]=[];let total=0,done=false;try{for(;;){s.throwIfAborted();const x=await reader.read();if(x.done){done=true;break;}total+=x.value.length;if(total>2*1024*1024)throw new Error("Komari 响应过大");chunks.push(Buffer.from(x.value));}}finally{try{if(!done)await reader.cancel();}catch{}finally{reader.releaseLock();}}let data:any;try{data=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new Error("Komari 返回无效 JSON");}if(!r.ok)throw new Error(`HTTP ${r.status}`);if(data?.status!=="success"||data.data===undefined)throw new Error("Komari 响应结构异常");return data.data;},{timeoutMs:10_000,redirects:{allowedHosts:[u.hostname],maxRedirects:2}});}
function renderReport(text:string){return esc(text).replace(/\*\*([^\n]*?)\*\*/g,"<b>$1</b>").replace(/`([^`]*?)`/g,"<code>$1</code>");}
async function migrate(c:PluginContext){const current=await store(c).read();if(current.legacyImported)return;let url="";try{const db=c.storage.legacySqlite("komari_config.db",{readonly:true});url=await db.read(x=>String((x.prepare("SELECT value FROM config WHERE key = ?").get("komari_url") as any)?.value??""));}catch{}await store(c).update(v=>({...v,url:v.url||url,legacyImported:true}));}
const guarded = (operation: CommandDefinition["handle"]): CommandDefinition["handle"] => async (invocation, c) => {
  try { await operation(invocation, c); }
  catch(e) { if(!c.signal.aborted) await c.telegram.edit(invocation.message, `❌ ${esc(e instanceof Error?e.message:"Komari 请求失败")}`, {parseMode:"html"}); }
};
const report = (select: (reports: ReturnType<typeof createReports>, root: URL, args: readonly string[]) => Promise<string>): CommandDefinition["handle"] => guarded(async (invocation, c) => {
  const m = invocation.message;
  const config = await store(c).read();
  if (!config.url) throw new Error("请先使用 komari _set_url <URL> 配置");
  const root = base(config.url);
  await c.telegram.edit(m, "正在获取 Komari 数据…");
  const reports = createReports(async (_base, endpoint) => ({status: "success", data: await get(c, root, endpoint)}));
  const out = await select(reports, root, invocation.args);
  const pages=(await ui.renderRichText(renderReport(out),ui.PAGE_LABEL_RESERVE)).map((page,index,all)=>page+ui.pageLabel(index,all.length));const delivery=await ui.deliverPages(pages,c.signal,(page,index)=>index?c.telegram.reply(m,page,{parseMode:"html"}):c.telegram.edit(m,page,{parseMode:"html"}));if(delivery.interrupted){c.log.info("pagination_delivery_interrupted",{plugin:"komari",published:delivery.published,total:delivery.total,category:ui.deliveryErrorCategory(delivery.error)});if(!delivery.published)throw delivery.error;try{await c.telegram.reply(m,ui.interruptedNotice(delivery),{parseMode:"html"});}catch{}}
});
const command: CommandDefinition = {
  description: "查询或配置 Komari", helpArgs: ["help", "h"], args: "", defaultSubcommand: "status", subcommandsCaseSensitive: true,
  examples: [{args: "", description: "查看服务器基本信息"}],
  subcommands: {
    _set_url: {description: "保存或更新服务地址", args: "地址", examples: [{args: "_set_url https://komari.example.com"}],
      help: [{heading: "地址：", body: "支持 HTTP/HTTPS，省略协议时默认 HTTPS，保留部署子路径。也可在插件设置的“服务地址”字段保存，配置在各对话间共用。保存时只校验格式，查询时才验证连接与响应。"}],
      handle: guarded(async (invocation, c) => {
        const url = invocation.args[0]; if (!url) throw new Error("请提供 Komari 地址");
        base(url); await store(c).update(v => ({...v, url: url.replace(/\/+$/, "")}));
        await c.telegram.edit(invocation.message, "Komari 地址已保存。");
      })},
    status: {description: "查看服务端基本信息", args: "", examples: [{args: "status"}], handle: report((reports, root) => reports.getServerInfo(root.href))},
    total: {description: "查看全部节点总览", args: "", examples: [{args: "total"}], handle: report((reports, root) => reports.getNodesOverview(root.href))},
    show: {description: "查看指定节点详情", args: "节点名", arguments: [{name: "节点名", required: true, description: "可包含空格；从 total 总览复制完整名称"}], examples: [{args: "show 香港节点"}],
      handle: report(async (reports, root, args) => { if (!args.length) throw new Error("未知子命令"); return reports.getNodeDetails(root.href, args.join(" ")); })},
  },
  help: [
    {heading: "首次使用：", body: "先保存服务地址，再查看 status、total，并按节点名称使用 show。需要 Komari 接口可直接访问，连接配置仅提供服务地址；长报告自动分页。"},
    {heading: "常见提示：", body: "未配置时先保存地址；HTTP 或响应结构异常时检查地址、服务在线状态和接口兼容性；节点未找到时用 total 核对名称。"},
  ],
  handle: report(async () => { throw new Error("未知子命令"); }),
};
const help = (prefix: string) => renderCommandHelp("komari", command, {prefix, title: "📡 Komari 服务器监控"});
export default function createKomari(){return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION,id:"komari",description:"查询 Komari 服务与节点状态",legacyStorage:{sqlite:["komari_config.db"]},commands:{komari: command},settings:c=>({id:"komari",title:"Komari",category:"插件配置",icon:"📡",getSchema:()=>[{key:"url",label:"服务地址",type:"string"}],getValues:async()=>({url:(await store(c).read()).url}),async setValues(p){if(typeof p.url!=="string")throw new Error("invalid URL");const url=p.url;base(url);await store(c).update(v=>({...v,url:url.replace(/\/+$/,"")}));}}),setup:migrate});}
