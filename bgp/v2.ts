import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, maskIpText, ui, type CommandDefinition, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import path from "node:path";
import type {Api, TelegramClient} from "teleproto";

export const BGP_INPUT_PIXEL_LIMIT = 32 * 1024 * 1024;

function sharp(input: Buffer, options: import("sharp").SharpOptions) {
  const createImage = require("sharp") as typeof import("sharp");
  return createImage(input, options);
}
export async function rasterizeGraph(input: Buffer, output: string): Promise<void> {
  await sharp(input, {density:300, limitInputPixels:BGP_INPUT_PIXEL_LIMIT})
    .resize({width:2400,height:1800,fit:"inside"}).png({compressionLevel:6}).toFile(output);
}
export function privateGraph(source: string): string {
  const {load} = require("cheerio") as typeof import("cheerio");
  const document = load(source, {xmlMode: true});
  const visit = (node: any): void => {
    if (node.type === "text") node.data = maskIpText(node.data);
    if (node.attribs) for (const key of Object.keys(node.attribs)) {
      if (maskIpText(node.attribs[key]) !== node.attribs[key]) delete node.attribs[key];
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(document.root().get(0));
  return document.xml();
}

const HOST = "bgp.tools";
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!));
const valid = (ip:string) => {const p=ip.split(".");return p.length===4&&p.every(x=>/^\d{1,3}$/.test(x)&&Number(x)<=255);};
function extract(text:string){const m=text.match(/(?:^|\D)(\d{1,3}(?:\.\d{1,3}){3})(?:\/\d{1,2})?(?:\D|$)/);return m&&valid(m[1]!)?m[1]!:"";}
function prefix(ip:string,bits:23|24){const p=ip.split(".").map(Number);const n=(((p[0]!<<24)|(p[1]!<<16)|(p[2]!<<8)|p[3]!)>>>0);const mask=(~0<<(32-bits))>>>0;const x=(n&mask)>>>0;return `${(x>>>24)&255}.${(x>>>16)&255}.${(x>>>8)&255}.${x&255}/${bits}`;}
async function input(message:MessageEnvelope,args:readonly string[],ctx:PluginContext){const direct=extract(args.join(" "));if(direct)return direct;const reply=await ctx.telegram.getReply(message);return extract(reply?.text??"");}
async function readBounded(response:Response,signal:AbortSignal,limit:number){const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);const chunks:Buffer[]=[];let total=0;try{while(true){signal.throwIfAborted();const x=await reader.read();if(x.done)break;total+=x.value.byteLength;if(total>limit)throw new Error("large");chunks.push(Buffer.from(x.value));}return Buffer.concat(chunks);}finally{reader.releaseLock();}}
async function text(ctx:PluginContext,url:string){return ctx.http.withResponse(url,{headers:{"user-agent":"MiBot/2","accept":"text/html,application/xhtml+xml"}},async (r,signal)=>{if(r.status===404)return"";if(!r.ok)throw new Error("status");return (await readBounded(r,signal,2*1024*1024)).toString("utf8");},{timeoutMs:15000,redirects:{allowedHosts:[HOST],maxRedirects:2}});}
async function bytes(ctx:PluginContext,url:string){return ctx.http.withResponse(url,{headers:{"user-agent":"MiBot/2","accept":"image/svg+xml"}},async(r,signal)=>{if(r.status===404)return Buffer.alloc(0);if(!r.ok)throw new Error("status");return readBounded(r,signal,2*1024*1024);},{timeoutMs:15000,redirects:{allowedHosts:[HOST],maxRedirects:2}});}
async function dns(ctx:PluginContext,ip:string){for(const p of [prefix(ip,24),prefix(ip,23)]){const html=await text(ctx,`https://${HOST}/prefix/${p}#dns`);if(!html)continue;const plain=html.replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ");const matches=[...plain.matchAll(/(\d{1,3}(?:\.\d{1,3}){3})\s+([a-z0-9.-]+\.[a-z]{2,})/gi)];const count=new Map<string,number>();const rows=matches.flatMap(m=>{if(!valid(m[1]!))return[];const domain=m[2]!.toLowerCase();const root=domain.split(".").slice(-2).join(".");count.set(root,(count.get(root)??0)+1);return[{ip:m[1]!,domain,root}];});const lines=rows.filter(x=>(count.get(x.root)??0)<=2).map(x=>`${x.ip}\t${x.domain}`);if(lines.length)return{p,lines};}return undefined;}
type GraphResult={status:"ok";p:string;raw:Buffer}|{status:"placeholder";p:string}|{status:"none"};
async function graph(ctx:PluginContext,ip:string):Promise<GraphResult>{let placeholder="";for(const p of [prefix(ip,24),prefix(ip,23)]){const raw=await bytes(ctx,`https://${HOST}/pathimg/rt-${p.replace("/","_")}?loggedin`);if(!raw.length)continue;const source=raw.toString("utf8");if(source.includes("Not_Visible")&&source.includes("in_DFZ")){placeholder=p;continue;}return{status:"ok",p,raw};}return placeholder?{status:"placeholder",p:placeholder}:{status:"none"};}
async function messagePeer(message:MessageEnvelope):Promise<Parameters<TelegramClient["sendFile"]>[0]>{const raw=message.raw as Api.Message|undefined;const attached=raw?.inputChat??raw?.peerId;if(attached)return attached;const{returnBigInt}=await import("teleproto/Helpers.js");return returnBigInt(message.chatId);}
async function deliverDns(ctx:PluginContext,message:MessageEnvelope,ip:string,p:string,lines:readonly string[]){const rendered=await ui.renderDocument({title:"🌐 DNS解析记录",subtitle:`${ip} · 使用前缀: ${p}`,sections:[ui.section(undefined,[ui.text("A\tDNS"),...lines.map(line=>ui.text(line))]),ui.section(undefined,[ui.text(`⏰ ${new Date().toLocaleString("zh-CN")}`)])]},ui.PAGE_LABEL_RESERVE);const pages=rendered.map((page,index)=>page+ui.pageLabel(index,rendered.length));const delivery=await ui.deliverPages(pages,ctx.signal,(page,index)=>index?ctx.telegram.reply(message,page,{parseMode:"html"}):ctx.telegram.edit(message,page,{parseMode:"html"}));if(delivery.interrupted)ctx.log.info("bgp_dns_pagination_interrupted",{plugin:"bgp",published:delivery.published,total:delivery.total,category:ui.deliveryErrorCategory(delivery.error)});}

export default function createBgp(){
  const bgpCommand: CommandDefinition = {
    description: "查询 BGP 路由或 DNS",
    args: "[IP]",
    arguments: [{name: "IP", description: "IPv4 地址；省略时读取回复消息中的 IPv4"}],
    examples: [{args: "1.1.1.1"}, {args: "", description: "回复包含 IPv4 的消息"}],
    subcommandsCaseSensitive: false,
    subcommands: {
      dns: {description: "查询指定 IP 的 DNS 解析记录", args: "[IP]", arguments: [{name: "IP", description: "IPv4 地址；省略时读取回复消息"}], examples: [{args: "dns 1.1.1.1"}], handle: async (invocation, ctx) => {
        const ip = await input(invocation.message, invocation.args, ctx);
        if (!ip) { await ctx.telegram.edit(invocation.message, renderCommandHelp("bgp", bgpCommand, {prefix: invocation.prefix}), {parseMode: "html"}); return; }
        await ctx.telegram.edit(invocation.message, "🔍 正在查询 DNS 记录…");
        try {
          const result = await dns(ctx, ip);
          if (!result) { const p=prefix(ip,24);await ctx.telegram.edit(invocation.message, `❌ <b>未找到DNS解析记录</b>\n\n请确认该前缀是否在公网上有宣告或有可见的 DNS 记录\n\n🔗 直达链接: https://${HOST}/prefix/${p}#dns`,{parseMode:"html"}); return; }
          await deliverDns(ctx,invocation.message,ip,result.p,result.lines);
        } catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "❌ <b>DNS查询失败</b>\n\n上游服务暂时不可用",{parseMode:"html"}); }
      }},
    },
    help: [
      {heading: "说明：", body: "直接填写 IPv4（或回复包含 IPv4 的消息）查询 BGP 路由图；<code>{prefix}bgp dns</code> 切换为查询 DNS 解析记录。"},
    ],
    async handle(invocation, ctx) {
      const ip = await input(invocation.message, invocation.args, ctx);
      if (!ip) { await ctx.telegram.edit(invocation.message, renderCommandHelp("bgp", bgpCommand, {prefix: invocation.prefix}), {parseMode: "html"}); return; }
      await ctx.telegram.edit(invocation.message, "🔍 正在生成 BGP 路由图…");
      let deleted=false;
      try {
        const result = await graph(ctx, ip);
        if(result.status==="placeholder"){await ctx.telegram.edit(invocation.message,`❌ <b>没有可用的BGP路由图</b>\n\n当前前缀 <code>${result.p}</code> 在 DFZ 中不可见或没有路径数据\n\n🔗 直达链接: https://${HOST}/prefix/${result.p}`,{parseMode:"html"});return;}
        if(result.status==="none"){const p=prefix(ip,24);await ctx.telegram.edit(invocation.message,`❌ <b>未找到可用的BGP路由图</b>\n\n请确认该前缀是否在公网上有宣告\n\n🔗 直达链接: https://${HOST}/prefix/${p}`,{parseMode:"html"});return;}
        await ctx.files.withTemp(async dir => {
          const file = path.join(dir, "bgp.png");
          await rasterizeGraph(Buffer.from(privateGraph(result.raw.toString("utf8"))), file);
          await ctx.telegram.withClient(async (client, signal) => {
            const peer=await messagePeer(invocation.message);
            signal.throwIfAborted();
            try{await client.deleteMessages(peer,[invocation.message.id],{revoke:false});deleted=true;}catch{ctx.log.info("bgp_command_delete_failed",{plugin:"bgp"});}
            signal.throwIfAborted();
            await client.sendFile(peer, {file, caption: `🌐 <b>BGP路由图</b>\n<code>${ip}</code>\n<i>使用前缀: ${result.p}</i>`, parseMode: "html"});
          });
        });
      } catch {if(ctx.signal.aborted)return;const error="❌ <b>BGP查询失败</b>\n\n上游服务或图片处理暂时不可用";if(!deleted)await ctx.telegram.edit(invocation.message,error,{parseMode:"html"});else await ctx.telegram.withClient(async(client,signal)=>{const peer=await messagePeer(invocation.message);signal.throwIfAborted();await client.sendMessage(peer,{message:error,parseMode:"html"});});}
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "bgp", description: "查询 IPv4 的 BGP 路由图与 DNS 记录",
    renderHelp: prefix => renderCommandHelp("bgp", bgpCommand, {prefix, title: "🌐 BGP路由图查询工具"}),
    commands: {bgp: bgpCommand}});
}
