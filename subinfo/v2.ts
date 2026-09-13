import {renderHelp as renderPluginHelp} from "./v2/help";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, requireSdkFeatures, ui, type CommandDefinition, type CommandInvocation, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {returnBigInt} from "teleproto/Helpers.js";
import {load, JSON_SCHEMA} from "js-yaml";
import {fetchBoundedText, fetchSubscription, trafficSummary} from "./v2/fetch";
export {trafficSummary};
const MAPPINGS_URL="https://raw.githubusercontent.com/Hyy800/Quantumult-X/refs/heads/Nana/ymys.txt";
requireSdkFeatures("httpAddressPolicy");
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
const protocols = ["vmess", "vless", "trojan", "ss", "ssr", "hysteria2", "hy2", "tuic", "socks", "socks5", "hysteria", "hy", "wireguard", "http", "https", "shadowtls", "naive"];
const regions: [string, string[]][] = [["香港", ["香港", "hong kong", "hongkong", "hkg", "hk"]], ["台湾", ["台湾", "taiwan", "taipei", "tpe", "tw"]], ["日本", ["日本", "japan", "osaka", "jap", "jp", "tokyo"]], ["新加坡", ["新加坡", "singapore", "sgp", "sg"]], ["韩国", ["韩国", "korea", "seoul", "kor", "kr"]], ["印度", ["印度", "india"]], ["马来西亚", ["马来西亚", "malaysia"]], ["泰国", ["泰国", "thailand"]], ["越南", ["越南", "vietnam"]], ["印度尼西亚", ["印度尼西亚", "indonesia"]], ["菲律宾", ["菲律宾", "philippines"]], ["土耳其", ["土耳其", "turkey"]], ["美国", ["美国", "united states", "usa", "us"]], ["加拿大", ["加拿大", "canada", "ca"]], ["英国", ["英国", "united kingdom", "uk", "london"]], ["德国", ["德国", "germany", "de"]], ["法国", ["法国", "france"]], ["荷兰", ["荷兰", "netherlands"]], ["瑞士", ["瑞士", "switzerland"]], ["意大利", ["意大利", "italy"]], ["西班牙", ["西班牙", "spain"]], ["澳大利亚", ["澳大利亚", "australia", "au"]], ["新西兰", ["新西兰", "new zealand"]], ["巴西", ["巴西", "brazil"]], ["阿联酋", ["阿联酋", "uae"]], ["以色列", ["以色列", "israel"]], ["南非", ["南非", "south africa"]], ["俄罗斯", ["俄罗斯", "russia"]]];
function nodeName(line: string, type: string, index: number): string {
  const hash = line.indexOf("#");
  if (hash >= 0 && line.slice(hash + 1)) {
    try {return decodeURIComponent(line.slice(hash + 1));} catch {return line.slice(hash + 1);}
  }
  if (type === "vmess") {
    try {
      const data: unknown = JSON.parse(Buffer.from(line.slice(line.indexOf("://") + 3), "base64url").toString("utf8"));
      if (data && typeof data === "object" && "ps" in data && typeof data.ps === "string" && data.ps.trim()) return data.ps;
    } catch { /* Invalid node metadata does not invalidate other subscription entries. */ }
  }
  if (type === "ssr") {
    const decoded = Buffer.from(line.slice(line.indexOf("://") + 3), "base64url").toString("utf8");
    const query = decoded.indexOf("/?");
    if (query >= 0) {
      const remarks = new URLSearchParams(decoded.slice(query + 2)).get("remarks");
      if (remarks) {
        const name = Buffer.from(remarks, "base64url").toString("utf8");
        if (name.trim()) return name;
      }
    }
  }
  return `${type.toUpperCase()} ${index + 1}`;
}
function parse(raw: string) {
  let text = raw.trim();
  if (!text) throw new Error("订阅内容为空");
  try {
    const decoded = Buffer.from(text.replace(/\s/g, ""), "base64").toString("utf8");
    if (decoded.includes("://")) text = decoded;
  } catch {}
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const counts: Record<string, number> = Object.create(null);
  const names: string[] = [];
  const regionCounts: Record<string, number> = {};
  const nodes: {type: string; name: string}[] = [];
  if (/^(?:proxies\s*:|\{)/m.test(text)) {
    const config: unknown = load(text, {schema: JSON_SCHEMA});
    if (!config || typeof config !== "object" || !("proxies" in config) || !Array.isArray(config.proxies)) throw new Error("无效的 Clash 节点列表");
    for (const proxy of config.proxies) {
      if (!proxy || typeof proxy !== "object" || typeof proxy.type !== "string" || !proxy.type.trim()) throw new Error("无效的 Clash 节点");
      const type = proxy.type.toLowerCase();
      // Only display names and protocol labels, never serialize credential-bearing node objects.
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(type)) throw new Error("无效的 Clash 协议");
      nodes.push({type, name: typeof proxy.name === "string" && proxy.name.trim() ? proxy.name : `${type.toUpperCase()} ${nodes.length + 1}`});
    }
  } else {
    for (const line of lines) {
      const type = protocols.find(p => line.toLowerCase().startsWith(`${p}://`));
      if (type) nodes.push({type, name: nodeName(line, type, nodes.length)});
    }
  }
  for (const {type, name} of nodes) {
    counts[type] = (counts[type] ?? 0) + 1;
    names.push(name);
    const lower = name.toLowerCase();
    const found = regions.find(([, keys]) => keys.some(key => /^[a-z]+$/.test(key)
      ? new RegExp(`(?:^|[^a-z])${key}(?:$|[^a-z])`).test(lower) : lower.includes(key)));
    if (found) regionCounts[found[0]] = (regionCounts[found[0]] ?? 0) + 1;
  }
  if (nodes.length - Object.values(regionCounts).reduce((a, b) => a + b, 0) > 0) regionCounts["其他"] = nodes.length - Object.values(regionCounts).reduce((a, b) => a + b, 0);
  return {total: nodes.length, counts, names, regionCounts};
}
type SiteInfo={website:string;name:string|null};
async function mappings(ctx:PluginContext):Promise<Record<string,string>>{
  try{const {response,text}=await fetchBoundedText(ctx,MAPPINGS_URL,256*1024,10_000,["raw.githubusercontent.com"]);if(!response.ok)return{};const result:Record<string,string>={};for(const raw of text.split(/\r?\n/)){const line=raw.trim(),at=line.indexOf("=");if(line&&!line.startsWith("#")&&at>0)result[line.slice(0,at).trim()]=line.slice(at+1).trim();}return result;}catch{ctx.signal.throwIfAborted();return{};}
}
function mappedName(url:string,map:Record<string,string>){for(const [key,value] of Object.entries(map))if(key&&url.includes(key))return value;return null;}
function headerName(value:string|null){if(!value)return null;try{for(const raw of value.split(";")){const part=raw.trim();if(part.toLowerCase().startsWith("filename*=")){const value=part.split("''").at(-1);if(value)return decodeURIComponent(value);}if(part.toLowerCase().startsWith("filename=")){const value=part.slice(part.indexOf("=")+1).trim().replace(/^["']|["']$/g,"");if(value)return decodeURIComponent(value);}}}catch{}return null;}
function titleOf(html:string){const match=html.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);if(!match)return null;return match[1].replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/\s+/g," ").trim().replace(/^登录\s*[—|-]\s*/,"").replace(/\s*[|]\s*登录$/,"")||null;}
async function websiteInfo(ctx:PluginContext,url:string):Promise<SiteInfo>{
  const target=new URL(url),origin=target.origin,headers={"user-agent":"Mozilla/5.0"};
  for(const candidate of [`${origin}/auth/login`,`${origin}/`])try{const {response,text}=await fetchBoundedText(ctx,candidate,512*1024,5_000,[target.hostname],headers);if(response.ok){const title=titleOf(text);return{website:origin,name:title?.includes("Cloudflare")||title?.includes("Just a moment")?"Cloudflare防御":title?.includes("Access denied")||title?.includes("404 Not Found")?"非机场面板域名":title};}}catch{ctx.signal.throwIfAborted();}
  return{website:origin,name:"连接失败"};
}
async function pagesFor(url: string, subscription: Awaited<ReturnType<typeof fetchSubscription>>, concise: boolean, site:SiteInfo, mapping:Record<string,string>): Promise<readonly string[]> {
  const result = parse(subscription.text);
  const types = Object.entries(result.counts).map(([name, count]) => `${name}: ${count}`).join("\n") || "未识别常见节点协议";
  const regionText = Object.entries(result.regionCounts).map(([name, count]) => `${name}: ${count}`).join(" · ");
  const config=mappedName(url,mapping)??headerName(subscription.contentDisposition)??site.name??"未知";
  const profile=subscription.profileUrl&&/^https?:\/\//i.test(subscription.profileUrl)?subscription.profileUrl:site.website;
  const identity=`<b>机场名称</b>：<code>${esc(config)}</code>\n<b>官网链接</b>：${esc(profile)}\n`;
  const summary = concise
    ? `${identity}<b>订阅链接</b>：<code>${esc(url)}</code>\n<b>节点总数</b>：${result.total}\n<b>流量与到期</b>：\n${esc(subscription.traffic)}`
    : `<b>订阅信息</b>\n${identity}节点总数: ${result.total}\n\n<b>流量与到期</b>\n${esc(subscription.traffic)}\n\n<b>协议分布</b>\n<pre>${esc(types)}</pre>${regionText ? `\n<b>地区分布</b>\n${esc(regionText)}` : ""}`;
  const document=summary+(result.names.length?`\n\n<b>节点列表</b>\n<pre>${esc(result.names.map((name,index)=>`${index+1}. ${name}`).join("\n"))}</pre>`:"");
  return ui.renderRichText(document,ui.PAGE_LABEL_RESERVE);
}
function htmlText(value:string):string{return value.replace(/<br\s*\/?>/gi,"\n").replace(/<[^>]+>/g,"").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&gt;/g,">").replace(/&lt;/g,"<").replace(/&amp;/g,"&");}
async function urls(invocation: CommandInvocation, ctx: PluginContext): Promise<{values:string[]; txt:boolean}> {
  const txt = invocation.args[0]?.toLowerCase() === "txt";
  const args = txt ? invocation.args.slice(1) : invocation.args;
  let source = args.join(" ");
  if (invocation.message.replyToId || !args.length) {
    ctx.signal.throwIfAborted();
    const reply = await ctx.telegram.getReply(invocation.message);
    ctx.signal.throwIfAborted();
    source += ` ${reply?.text ?? ""}`;
  }
  const values = [...new Set(source.match(/https?:\/\/[^\s"'<>]+/gi) ?? [])];
  return {values: values.filter(value => value.length <= 2048), txt};
}
async function deliver(ctx: PluginContext, message: MessageEnvelope, pages: readonly string[]): Promise<void> {
  const labeled = pages.map((page,index,all)=>page+ui.pageLabel(index,all.length));
  const result = await ui.deliverPages(labeled,ctx.signal,(page,index)=>index ? ctx.telegram.reply(message,page,{parseMode:"html"}) : ctx.telegram.edit(message,page,{parseMode:"html"}));
  if (!result.interrupted) return;
  ctx.log.error("subinfo_page_delivery_failed", {category: ui.deliveryErrorCategory(result.error), published: result.published, total: result.total});
  if (!result.published) throw new Error("delivery failed");
  await ctx.telegram.reply(message,ui.interruptedNotice(result)).catch(()=>{});
}
function command(concise: boolean): CommandDefinition {
  return {helpArgs:["help","h"],description:concise?"简洁查询订阅信息":"查看订阅基础信息",async handle(invocation,ctx){
    try {
      const input=await urls(invocation,ctx);
      if (!input.values.length) {await deliver(ctx,invocation.message,await ui.renderRichText(renderPluginHelp(invocation.prefix),ui.PAGE_LABEL_RESERVE));return;}
      await ctx.telegram.edit(invocation.message,`正在读取 ${input.values.length} 个订阅…`);
      const mapping=await mappings(ctx);
      const all:string[]=[];
      for(const url of input.values){
        ctx.signal.throwIfAborted();
        try{const site=await websiteInfo(ctx,url),subscription=await fetchSubscription(ctx,url);all.push(...await pagesFor(url,subscription,concise,site,mapping));}
        catch{ctx.signal.throwIfAborted();const failure=input.values.length===1?"订阅读取或解析失败，请稍后重试":`<b>订阅链接</b>：<code>${esc(url)}</code>\n订阅读取或解析失败，请稍后重试`;all.push(...await ui.renderRichText(failure,ui.PAGE_LABEL_RESERVE));}
      }
      if(input.txt){
        const plain=htmlText(all.join("\n\n"));
        const peer=(invocation.message.raw as any)?.peerId??returnBigInt(invocation.message.chatId);
        await ctx.telegram.withClient(async(client,signal)=>{signal.throwIfAborted();await client.sendFile(peer,{file:Buffer.from(plain),caption:`✅ 订阅查询报告（共 ${input.values.length} 个链接）`,replyTo:invocation.message.id});signal.throwIfAborted();});
        ctx.signal.throwIfAborted();
        try{await ctx.telegram.withClient(async(client,signal)=>{signal.throwIfAborted();await client.deleteMessages(peer,[invocation.message.id],{revoke:true});signal.throwIfAborted();});}catch{ctx.signal.throwIfAborted();ctx.log.error("subinfo_command_cleanup_failed",{category:"DELETE_FAILED"});}
      }else await deliver(ctx,invocation.message,all);
    }catch{if(!ctx.signal.aborted)await ctx.telegram.edit(invocation.message,"订阅读取或解析失败，请稍后重试");}
  }};
}
export default function createSubinfo() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "subinfo", description: "查看订阅基础信息", commands: {subinfo:command(false),cha:command(true)}});
}
