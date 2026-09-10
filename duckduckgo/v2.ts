import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type PluginContext} from "telebox/sdk";

type Result = {title: string; url: string; snippet: string; source: string};
const DDG = "html.duckduckgo.com", FIRECRAWL = "api.firecrawl.dev";
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]!);
const clean = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
function parseArgs(args: readonly string[]) { let limit = 8; const words: string[] = []; for (let i=0;i<args.length;i++) { if (["-n","--num","-l","--limit"].includes(args[i]!) && args[i+1]) { const n=Number(args[++i]); if (Number.isFinite(n)) limit=Math.max(1,Math.min(15,Math.trunc(n))); } else words.push(args[i]!); } return {query: words.join(" ").trim(), limit}; }
function target(raw: string) { try { const u=new URL(raw, "https://duckduckgo.com"); const encoded=u.searchParams.get("uddg"); const parsed=new URL(encoded || u.toString()); return ["http:","https:"].includes(parsed.protocol) ? parsed.toString() : ""; } catch { return ""; } }
function parseHtml(html: string, limit: number): Result[] {
  const blocks = html.split(/class=["']result(?:\s|["'])/i).slice(1); const out: Result[]=[]; const seen=new Set<string>();
  for (const block of blocks) { const link=block.match(/class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i); if(!link) continue; const url=target(link[1]!); if(!url||seen.has(url)) continue; const snippet=block.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\//i); const title=clean(link[2]!); if(!title) continue; seen.add(url); out.push({title,url,snippet:clean(snippet?.[1]??""),source:"DuckDuckGo"}); if(out.length>=limit) break; }
  return out;
}
async function ddg(ctx: PluginContext, query: string, limit: number) { const body=new URLSearchParams({q:query}).toString(); const html=await ctx.http.text(`https://${DDG}/html/`, {method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","user-agent":"MiBot/2"},body}, {timeoutMs:15000,redirects:{allowedHosts:[DDG,"duckduckgo.com"],maxRedirects:3}}); return parseHtml(html,limit); }
async function fallback(ctx: PluginContext, query: string, limit: number): Promise<Result[]> { const data=await ctx.http.json<any>(`https://${FIRECRAWL}/v2/search`, {method:"POST",headers:{"content-type":"application/json","user-agent":"MiBot/2"},body:JSON.stringify({query,limit})}, {timeoutMs:15000,redirects:{allowedHosts:[FIRECRAWL],maxRedirects:1}}); const items=Array.isArray(data?.data?.web)?data.data.web:Array.isArray(data?.data)?data.data:[]; return items.slice(0,limit).flatMap((x:any)=>{try{const u=new URL(String(x?.url??"")); if(!["http:","https:"].includes(u.protocol))return[]; return [{title:String(x?.title||u.hostname).slice(0,200),url:u.toString(),snippet:String(x?.description||"").slice(0,600),source:"Firecrawl"}];}catch{return[];}}); }
function pages(query:string, items:Result[]) { const header=`🔍 <b>DuckDuckGo</b> · <code>${esc(query)}</code>`; if(!items.length)return[`${header}\n\n⚠️ 没有找到结果。可换关键词重试。`]; const blocks=items.map((r,i)=>`<b>${i+1}.</b> <a href="${esc(r.url)}">${esc(r.title.slice(0,120))}</a>\n<blockquote expandable>🏷 ${r.source}${r.snippet?`\n\n${esc(r.snippet.slice(0,280))}`:""}</blockquote>`); const out:string[]=[]; let current=header; for(const block of blocks){if(`${current}\n${block}`.length>3600){out.push(current);current=`🔍 <b>DuckDuckGo</b> · 续\n${block}`;}else current+=`\n${block}`;} out.push(current); return out; }
const duckCommand: CommandDefinition = {
  description: "搜索网页",
  args: "<关键词> [-n 数量]",
  arguments: [{name: "关键词", required: true, description: "搜索关键词，最长 200 字符"}, {name: "-n 数量", description: "结果条数 1–15，默认 8"}],
  examples: [{args: "关键词"}, {args: "关键词 -n 5"}],
  help: [
    {heading: "链路（自动）：", body: "通过 HTTP 请求 DuckDuckGo HTML 接口（User-Agent MiBot/2）获取结果；结果不足时使用 Firecrawl 免 Key 搜索补充。"},
    {heading: "别名：", body: "<code>{prefix}duckduckgo</code> 与 <code>{prefix}ddg</code> 相同。"},
  ],
  handle,
};
export default function createDuckDuckGo(){return definePlugin({apiVersion:STRUCTURED_PLUGIN_API_VERSION,id:"duckduckgo",description:"DuckDuckGo 网页搜索",
  renderHelp: prefix => renderCommandHelp("duckduckgo", duckCommand, {prefix, title:"🔍 DuckDuckGo 搜索"}),
  commands:{duckduckgo:duckCommand,ddg:duckCommand}});}
async function handle(invocation:any,ctx:PluginContext){const {query,limit}=parseArgs(invocation.args);if(!query||query.length>200){await ctx.telegram.edit(invocation.message,query?"❌ 关键词过长（最多 200 字符）":renderCommandHelp("duckduckgo", duckCommand, {prefix: invocation.prefix, title:"🔍 DuckDuckGo 搜索"}),{parseMode:"html"});return;}await ctx.telegram.edit(invocation.message,`⏳ 正在搜索 <code>${esc(query)}</code>…`,{parseMode:"html"});try{const items=await ddg(ctx,query,limit);if(items.length<limit){
  try {
    const more=await fallback(ctx,query,limit-items.length);
    const seen=new Set(items.map(x=>x.url));
    for(const item of more)if(!seen.has(item.url)){seen.add(item.url);items.push(item);}
  } catch(error) {
    ctx.signal.throwIfAborted();
    if(!items.length)throw error;
    ctx.log.info("duckduckgo_supplement_unavailable");
  }
}const chunks=pages(query,items.slice(0,limit));for(let i=0;i<chunks.length;i++){ctx.signal.throwIfAborted();if(i===0)await ctx.telegram.edit(invocation.message,chunks[i]!,{parseMode:"html",linkPreview:false});else await ctx.telegram.reply(invocation.message,chunks[i]!,{parseMode:"html",linkPreview:false});}}catch{if(!ctx.signal.aborted)await ctx.telegram.edit(invocation.message,"❌ 搜索失败，请稍后重试");}}
