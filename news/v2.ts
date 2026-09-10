import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, definePlugin, type PluginContext} from "telebox/sdk";
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" })[c]!);
type Data = {
  newsList?: {title: string; url: string}[];
  historyList?: {event: string}[];
  phrase?: {phrase: string; explain: string};
  sentence?: {sentence: string; author: string};
  poem?: {content: string[]; title: string; author: string};
};
async function load(ctx: PluginContext): Promise<Data> {
  const result = await ctx.http.json<{data?: Data}>("https://news.topurl.cn/api", {}, {timeoutMs: 15000, redirects:{allowedHosts:["news.topurl.cn"],maxRedirects:2}});
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
  const command: CommandDefinition = {
    args: "", examples: [{args: "", description: "获取完整每日资讯包"}],
    help: [{heading: "内容：", body: "每日新闻、历史上的今天、天天成语、慧语香风（名人名言）、诗歌天地。数据来自 news.topurl.cn，内容较长时自动分段发送。"}],
    helpArgs: ["help","h"], description: "获取每日新闻资讯", async handle(invocation, ctx) {
      if (invocation.args[0] === "help" || invocation.args[0] === "h") { await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode:"html"}); return; }
      if (invocation.args.length) {
        await ctx.telegram.edit(invocation.message, "未知参数，请使用 news help 查看帮助"); return;
      }
      try {
        await ctx.telegram.edit(invocation.message, "📰 正在获取今日资讯…");
        const output = pages(await load(ctx));
        if (!output.length) output.push("未获取到有效资讯");
        for (const [index, page] of output.entries()) {
          ctx.signal.throwIfAborted();
          if (index === 0) await ctx.telegram.edit(invocation.message, page, {parseMode:"html", linkPreview:false});
          else await ctx.telegram.reply(invocation.message, page, {parseMode:"html", linkPreview:false});
        }
      } catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "今日资讯获取失败，请稍后重试"); }
    }};
  const help = (prefix: string) => renderCommandHelp("news", command, {prefix, title: "🗞️ 每日新闻"});
  return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "news", description: "每日新闻资讯", commands: {
    news: command,
  }});
}
