import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, maskIpText, type CommandDefinition, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import path from "node:path";

function sharp(input: Buffer, options: import("sharp").SharpOptions) {
  const createImage = require("sharp") as typeof import("sharp");
  return createImage(input, options);
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
async function graph(ctx:PluginContext,ip:string){for(const p of [prefix(ip,24),prefix(ip,23)]){const raw=await bytes(ctx,`https://${HOST}/pathimg/rt-${p.replace("/","_")}?loggedin`);if(!raw.length)continue;const source=raw.toString("utf8");if(source.includes("Not_Visible")&&source.includes("in_DFZ"))continue;return{p,raw};}return undefined;}

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
          if (!result) { await ctx.telegram.edit(invocation.message, "❌ 未找到 DNS 解析记录"); return; }
          const body = `A\tDNS\n${result.lines.join("\n")}`.slice(0, 3500);
          await ctx.telegram.edit(invocation.message, `<blockquote expandable>${esc(body)}</blockquote>\n\n🌐 <b>DNS解析记录</b>\n<code>${ip}</code>\n<i>使用前缀: ${result.p}</i>`, {parseMode: "html"});
        } catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "❌ BGP 查询失败，请稍后重试"); }
      }},
    },
    help: [
      {heading: "说明：", body: "直接填写 IPv4（或回复包含 IPv4 的消息）查询 BGP 路由图；<code>{prefix}bgp dns</code> 切换为查询 DNS 解析记录。"},
    ],
    async handle(invocation, ctx) {
      const ip = await input(invocation.message, invocation.args, ctx);
      if (!ip) { await ctx.telegram.edit(invocation.message, renderCommandHelp("bgp", bgpCommand, {prefix: invocation.prefix}), {parseMode: "html"}); return; }
      await ctx.telegram.edit(invocation.message, "🔍 正在生成 BGP 路由图…");
      try {
        const result = await graph(ctx, ip);
        if (!result) { await ctx.telegram.edit(invocation.message, `❌ 没有可用的 BGP 路由图\n<code>${prefix(ip,24)}</code>`, {parseMode: "html"}); return; }
        await ctx.files.withTemp(async dir => {
          const file = path.join(dir, "bgp.png");
          await sharp(Buffer.from(privateGraph(result.raw.toString("utf8"))), {density:300}).resize({width:2400,height:1800,fit:"inside"}).png({compressionLevel:6}).toFile(file);
          await ctx.telegram.withClient(async (client, signal) => {
            signal.throwIfAborted();
            await client.sendFile(invocation.message.chatId, {file, caption: `🌐 <b>BGP路由图</b>\n<code>${ip}</code>\n<i>使用前缀: ${result.p}</i>`, parseMode: "html"});
          });
        });
      } catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "❌ BGP 查询失败，请稍后重试"); }
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "bgp", description: "查询 IPv4 的 BGP 路由图与 DNS 记录",
    renderHelp: prefix => renderCommandHelp("bgp", bgpCommand, {prefix, title: "🌐 BGP路由图查询工具"}),
    commands: {bgp: bgpCommand}});
}
