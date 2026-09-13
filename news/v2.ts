import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, ui, type PluginContext} from "telebox/sdk";
const help = `<b>每日新闻</b>\n<code>news</code> 获取新闻、历史、成语和诗词`;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
type Data = {
  newsList?: {title: string; url: string}[];
  historyList?: {event: string}[];
  phrase?: {phrase: string; explain: string};
  sentence?: {sentence: string; author: string};
  poem?: {content: string[]; title: string; author: string};
};
async function load(ctx: PluginContext): Promise<Data> {
  const result = await ctx.http.withResponse("https://news.topurl.cn/api", {headers:{accept:"application/json","user-agent":"TeleBox/1.0"}}, async (response, signal) => {
    if (!response.ok || !response.body) throw new Error("Invalid news response");
    const reader=response.body.getReader(),chunks:Buffer[]=[];let total=0,done=false,cancelPromise:Promise<void>|undefined;
    const cancel=()=>cancelPromise??=reader.cancel().catch(()=>{}),onAbort=()=>{void cancel();};signal.addEventListener("abort",onAbort,{once:true});
    try {for(;;){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done){done=true;break;}total+=part.value.byteLength;if(total>2*1024*1024)throw new Error("News response too large");chunks.push(Buffer.from(part.value));}}
    finally {signal.removeEventListener("abort",onAbort);if(!done)await cancel();if(cancelPromise)await cancelPromise;reader.releaseLock();}
    try{return JSON.parse(Buffer.concat(chunks,total).toString("utf8")) as {data?:Data};}catch{throw new Error("Invalid news JSON");}
  }, {timeoutMs: 15000, redirects:{allowedHosts:["news.topurl.cn"],maxRedirects:2}});
  if (!result?.data || typeof result.data !== "object") throw new Error("Invalid news data");
  return result.data;
}

function pages(data: Data): string[] {
  const blocks: string[] = [];
  // Split the source text before escaping, keeping every HTML tag and entity whole.
  function add(text: string, open = "", close = "") {
    if (typeof text !== "string" || !text) return;
    const budget = 3500 - open.length - close.length;
    if (budget < 1) throw new Error("News link too long");
    let chunk = "";
    for (const character of text) {
      const escaped = esc(character);
      if (chunk.length + escaped.length > budget) {
        blocks.push(open + chunk + close);
        chunk = "";
      }
      chunk += escaped;
    }
    if (chunk) blocks.push(open + chunk + close);
  }
  if (data.newsList?.length) {
    add("每日新闻", "<b>", "</b>");
    for (const [index, item] of data.newsList.entries()) {
      if (!item || typeof item.title !== "string" || typeof item.url !== "string") continue;
      let url: URL;
      try { url = new URL(item.url); } catch { continue; }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
      add(`${index + 1}. ${item.title}`, `<a href="${esc(url.href)}">`, "</a>");
    }
  }
  if (data.historyList?.length) {
    add("历史上的今天", "<b>", "</b>");
    for (const item of data.historyList) add(item?.event);
  }
  if (data.phrase) {
    add("天天成语", "<b>", "</b>");
    add(data.phrase.phrase, "<b>", "</b>");
    add(data.phrase.explain);
  }
  if (data.sentence) {
    add("慧语香风", "<b>", "</b>");
    add(data.sentence.sentence, "<i>", "</i>");
    add(data.sentence.author);
  }
  if (data.poem) {
    add("诗歌天地", "<b>", "</b>");
    add(data.poem.title, "<b>", "</b>");
    add(data.poem.author);
    if (!Array.isArray(data.poem.content) || data.poem.content.some(line => typeof line !== "string")) throw new Error("Invalid poem");
    add(data.poem.content.join("\n"), "<i>", "</i>");
  }
  const result: string[] = [];
  let page = "";
  for (const block of blocks) {
    if (page && page.length + block.length + 1 > 3500) {result.push(page); page = "";}
    page += (page ? "\n" : "") + block;
  }
  if (page) result.push(page);
  return result;
}
export default function createNews() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "news", description: "每日新闻资讯", commands: {
    news: {helpArgs: ["help","h"], description: "获取每日新闻资讯", async handle(invocation, ctx) {
      if (invocation.args[0] === "help" || invocation.args[0] === "h") { await ctx.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), {parseMode:"html"}); return; }
      if (invocation.args.length) {
        await ctx.telegram.edit(invocation.message, `未知参数，请使用 ${invocation.prefix}news help 查看帮助`); return;
      }
      try {
        await ctx.telegram.edit(invocation.message, "📰 正在获取今日资讯…");
        const output = pages(await load(ctx));
        if (!output.length) output.push("未获取到有效资讯");
        const delivery=await ui.deliverPages(output,ctx.signal,(page,index)=>index===0
          ?ctx.telegram.edit(invocation.message,page,{parseMode:"html",linkPreview:false})
          :ctx.telegram.reply(invocation.message,page,{parseMode:"html",linkPreview:false}));
        if(delivery.interrupted){ctx.log.error("news_result_delivery_failed");if(!delivery.published)throw delivery.error;try{await ctx.telegram.reply(invocation.message,ui.interruptedNotice(delivery));}catch{if(!ctx.signal.aborted)ctx.log.error("news_interrupted_notice_failed");}}
      } catch { if (!ctx.signal.aborted){ctx.log.error("news_request_failed");try{await ctx.telegram.edit(invocation.message, "今日资讯获取失败，请稍后重试");}catch{ctx.log.error("news_failure_receipt_failed");}} }
    }},
  }});
}
