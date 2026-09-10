import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, ui, type CommandDefinition, type PluginContext, type SubcommandDefinition} from "telebox/sdk";

type Repo={tag:string;repo:string;url:string;addedAt:string};
type Turn={q:string;a:string;at:string};
type Chat={currentTag:string;repos:Record<string,Repo>;contextEnabled:boolean;turns:Record<string,Turn[]>};
type Data={schemaVersion:number;chats:Record<string,Chat>;legacyImported?:boolean};
const HOST="mcp.deepwiki.com", MAX_TURNS=50, MAX_QUESTION=48_000;
const defaults:Data={schemaVersion:1,chats:{}};
const esc=(s:string)=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]!);
const store=(ctx:PluginContext)=>ctx.storage.json<Data>("data.json",defaults);
const key=(m:{chatId:string;topicId?:number})=>m.topicId?`${m.chatId}:topic:${m.topicId}`:m.chatId;
const empty=():Chat=>({currentTag:"",repos:{},contextEnabled:false,turns:{}});
function repoUrl(raw:string){try{const u=new URL(raw);if(!["github.com","deepwiki.com"].includes(u.hostname.toLowerCase()))return;let p=u.pathname.split("/").filter(Boolean);if(u.hostname==="deepwiki.com"&&p[0]==="browse"&&p[1]==="github.com")p=p.slice(2);const owner=p[0],name=p[1]?.replace(/\.git$/i,"");if(!owner||!name||!/^[\w.-]+$/.test(owner)||!/^[\w.-]+$/.test(name))return;return{repo:`${owner}/${name}`,url:`https://github.com/${owner}/${name}`};}catch{return;}}
function responseValue(text:string):any{const lines=text.split(/\r?\n/).filter(x=>x.startsWith("data:"));const raw=lines.length?lines.at(-1)!.slice(5).trim():text.trim();return JSON.parse(raw);}
async function boundedText(response:Response,signal:AbortSignal){const reader=response.body?.getReader();if(!reader)return"";const decoder=new TextDecoder();const chunks:string[]=[];let total=0;try{while(true){signal.throwIfAborted();const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>2*1024*1024)throw new Error("large");chunks.push(decoder.decode(part.value,{stream:true}));}chunks.push(decoder.decode());return chunks.join("");}finally{reader.releaseLock();}}
async function rpc(ctx:PluginContext,body:unknown,session?:string){return ctx.http.withResponse(`https://${HOST}/mcp`,{method:"POST",headers:{accept:"application/json, text/event-stream","content-type":"application/json",...(session?{"mcp-session-id":session}:{})},body:JSON.stringify(body)},async (response,signal)=>{if(!response.ok)throw new Error("status");const sessionId=response.headers.get("mcp-session-id")??session;const value=response.status===202?undefined:responseValue(await boundedText(response,signal));return{session:sessionId,value};},{timeoutMs:30000,redirects:{allowedHosts:[HOST],maxRedirects:1}});}
async function ask(ctx:PluginContext,repo:string,question:string){const init=await rpc(ctx,{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"mibot-deepwiki",version:"2"}}});if(!init.session)throw new Error("session");await rpc(ctx,{jsonrpc:"2.0",method:"notifications/initialized"},init.session);const result=await rpc(ctx,{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"ask_question",arguments:{repoName:repo,question}}},init.session);const content=result.value?.result?.content;if(!Array.isArray(content))throw new Error("content");const text=content.filter((x:any)=>x?.type==="text"&&typeof x.text==="string").map((x:any)=>x.text).join("\n").split("Wiki pages you might want to explore:")[0]!.trim();if(!text)throw new Error("empty");return text;}
function prefixText(value:string,limit:number):string {
  const end=Math.min(value.length,limit);
  const last=value.charCodeAt(end-1);
  return value.slice(0,end-(last>=0xd800&&last<=0xdbff?1:0));
}
function textLines(value:string):ui.Html[] {
  const lines:ui.Html[]=[];
  let line="",length=0;
  for(const character of value){
    const size=ui.text(character).length;
    if(length+size>2800){lines.push(ui.text(line));line="";length=0;}
    line+=character;length+=size;
  }
  if(line)lines.push(ui.text(line));
  return lines;
}
async function render(repo:string,q:string,a:string){
  return ui.renderDocument({title:"DeepWiki",sections:[
    ui.section("项目",[ui.code(repo)]),
    ui.section("Q",textLines(prefixText(q,1200))),
    ui.section("A",textLines(a)),
  ]});
}

export default function createDeepWiki(){
  const scope = async (ctx: PluginContext, message: {chatId: string; topicId?: number}) => {
    const chatKey = key(message);
    const data = await store(ctx).read();
    const state = data.chats[chatKey] ?? empty();
    const save = async () => { await store(ctx).update(d => ({...d, schemaVersion: 1, chats: {...d.chats, [chatKey]: state}})); };
    return {state, save};
  };
  const guard = async (invocation: any, ctx: PluginContext, body: () => Promise<void>) => {
    try { await body(); }
    catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "❌ DeepWiki 操作失败，请检查参数或稍后重试"); }
  };
  const edit = (invocation: any, ctx: PluginContext, text: string) => ctx.telegram.edit(invocation.message, text, {parseMode: "html"});

  const ctxNode: SubcommandDefinition = {
    description: "查看或管理上下文开关", args: "", examples: [{args: "ctx"}],
    subcommands: {
      on: {description: "开启上下文", args: "", examples: [{args: "on"}], async handle(invocation, c) { return guard(invocation, c, async () => {
        const {state, save} = await scope(c, invocation.message); state.contextEnabled = true; await save();
        await c.telegram.edit(invocation.message, "✅ 上下文已开启");
      }); }},
      off: {description: "关闭上下文", args: "", examples: [{args: "off"}], async handle(invocation, c) { return guard(invocation, c, async () => {
        const {state, save} = await scope(c, invocation.message); state.contextEnabled = false; await save();
        await c.telegram.edit(invocation.message, "✅ 上下文已关闭");
      }); }},
      del: {description: "清空上下文", args: "[标签|all]", examples: [{args: "del"}, {args: "del node"}, {args: "del all"}],
        arguments: [{name: "目标", description: "省略为当前项目，all 清空当前对话全部项目"}],
        async handle(invocation, c) { return guard(invocation, c, async () => {
          const {state, save} = await scope(c, invocation.message);
          const tag = invocation.args[0] ?? state.currentTag;
          if (invocation.args[0] === "all") state.turns = {}; else if (tag) delete state.turns[tag];
          await save();
          await c.telegram.edit(invocation.message, "✅ 上下文已清空");
        }); }},
    },
    async handle(invocation, c) { return guard(invocation, c, async () => {
      const {state} = await scope(c, invocation.message);
      await c.telegram.edit(invocation.message, `上下文：${state.contextEnabled ? "开" : "关"}；当前项目：${state.currentTag || "未设置"}`);
    }); },
  };

  const deepwikiCommand: CommandDefinition = {
    description: "管理项目并向 DeepWiki 提问",
    args: "[标签] 问题",
    helpArgs: ["help", "h"],
    helpOnEmpty: true,
    subcommandsCaseSensitive: false,
    subcommands: {
      add: {description: "添加或更新项目并设为当前", args: "标签 项目URL",
        arguments: [{name: "标签", required: true, description: "1–40 位字母、数字、下划线、点或连字符"}, {name: "项目URL", required: true, description: "github.com 或 deepwiki.com 项目地址"}],
        examples: [{args: "add node https://github.com/nodejs/node"}],
        async handle(invocation, c) { return guard(invocation, c, async () => {
          const {state, save} = await scope(c, invocation.message);
          const tag = invocation.args[0]?.trim(), parsed = repoUrl(invocation.args[1] ?? "");
          if (!tag || !/^[\w.-]{1,40}$/.test(tag) || !parsed) throw new Error("invalid");
          state.repos[tag] = {tag, ...parsed, addedAt: new Date().toISOString()}; state.currentTag = tag;
          await save();
          await edit(invocation, c, `✅ 已添加 <code>${esc(tag)}</code>：<code>${esc(parsed.repo)}</code>`);
        }); }},
      lst: {description: "查看当前对话的项目列表", args: "", examples: [{args: "lst"}],
        async handle(invocation, c) { return guard(invocation, c, async () => {
          const {state} = await scope(c, invocation.message);
          const rows = Object.values(state.repos).sort((a, b) => a.tag.localeCompare(b.tag)).map(x => `${x.tag === state.currentTag ? "✅" : "•"} <code>${esc(x.tag)}</code> — ${esc(x.repo)}`);
          await edit(invocation, c, `<b>项目列表</b>\n${rows.join("\n") || "暂无项目"}`);
        }); }},
      use: {description: "切换当前项目", args: "标签", examples: [{args: "use node"}],
        arguments: [{name: "标签", required: true}],
        async handle(invocation, c) { return guard(invocation, c, async () => {
          const {state, save} = await scope(c, invocation.message);
          const tag = invocation.args[0] ?? "";
          if (!state.repos[tag]) throw new Error("missing");
          state.currentTag = tag; await save();
          await edit(invocation, c, `✅ 已切换到 <code>${esc(tag)}</code>`);
        }); }},
      del: {description: "删除项目及其上下文", args: "标签", examples: [{args: "del node"}],
        arguments: [{name: "标签", required: true}],
        async handle(invocation, c) { return guard(invocation, c, async () => {
          const {state, save} = await scope(c, invocation.message);
          const tag = invocation.args[0] ?? "";
          if (!state.repos[tag]) throw new Error("missing");
          delete state.repos[tag]; delete state.turns[tag]; if (state.currentTag === tag) state.currentTag = "";
          await save();
          await edit(invocation, c, `✅ 已删除 <code>${esc(tag)}</code>`);
        }); }},
      ctx: ctxNode,
    },
    examples: [{args: "add node https://github.com/nodejs/node"}, {args: "node 事件循环如何工作？"}, {args: "相关源码主要在哪些目录？"}, {args: "ctx on"}, {args: "ctx del node"}],
    help: [
      {heading: "提问：", body: "向当前项目提问，或为本次提问指定项目（首个参数为已保存标签）；回复文字消息后提问会一并提交引用文字。上下文默认关闭。"},
      {heading: "项目管理：", body: "add 添加或更新项目并设为当前；lst 查看当前对话项目；use 切换当前项目；del 删除项目及其上下文，删除当前项目后需重新选择项目。"},
      {heading: "参数与保存范围：", body: "标签为 1–40 位字母、数字、下划线、点或连字符，按原标签匹配；URL 支持 github.com 或 deepwiki.com，项目需已被 DeepWiki 索引。项目、当前选择和上下文按对话保存，论坛话题分别保存；每个项目最多保留最近 50 轮。关闭上下文后暂停使用和记录历史，已有历史保留。请求文本包括本次问题、引用文字及启用的历史，上限 48000 字符，超出时保留末尾内容。"},
      {heading: "常见提示：", body: "操作失败时先用 lst 和 ctx 核对项目、标签与开关，再检查项目在 DeepWiki 上是否可用。长回答会分多条消息显示。"},
    ],
    async handle(invocation, c) { return guard(invocation, c, async () => {
      const message = invocation.message;
      const sub = (invocation.args[0] ?? "").toLowerCase();
      if (!sub || sub === "help" || sub === "h") { await edit(invocation, c, renderCommandHelp("deepwiki", deepwikiCommand, {prefix: invocation.prefix, title: "📚 DeepWiki 项目问答"})); return; }
      const {state, save} = await scope(c, message);
      let tag = state.currentTag, q = invocation.args.join(" ").trim();
      if (state.repos[invocation.args[0]!] && invocation.args.length > 1) { tag = invocation.args[0]!; q = invocation.args.slice(1).join(" ").trim(); }
      const reply = message.replyToId !== undefined ? await c.telegram.getReply(message) : undefined;
      if (reply?.text) q = `${reply.text}\n\n${q}`.trim();
      if (!tag || !state.repos[tag]) throw new Error("missing project");
      if (!q) throw new Error("missing question");
      const turns = state.contextEnabled ? (state.turns[tag] ?? []) : [];
      const context = turns.map((t, i) => `Q${i + 1}: ${t.q}\nA${i + 1}: ${t.a}`).join("\n\n");
      const final = (context ? `${context}\n\n当前问题: ${q}` : q).slice(-MAX_QUESTION);
      await edit(invocation, c, "💬 <b>DeepWiki 正在处理</b>");
      const answer = await ask(c, state.repos[tag]!.repo, final);
      if (state.contextEnabled) { state.turns[tag] = [...turns, {q, a: answer.slice(0, 12000), at: new Date().toISOString()}].slice(-MAX_TURNS); await save(); }
      const output = await render(state.repos[tag]!.repo, q, prefixText(answer, MAX_QUESTION));
      for (let i = 0; i < output.length; i++) {
        if (i === 0) await c.telegram.edit(message, output[i]!, {parseMode: "html", linkPreview: false});
        else await c.telegram.reply(message, output[i]!, {parseMode: "html", linkPreview: false});
      }
    }); },
  };

  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "deepwiki", description: "基于 DeepWiki 查询 GitHub 项目文档",
    renderHelp: prefix => renderCommandHelp("deepwiki", deepwikiCommand, {prefix, title: "📚 DeepWiki 项目问答"}),
    async setup(ctx) { const db = store(ctx); const current = await db.read(); if (current.legacyImported) return;
      const legacyMain = await ctx.storage.json<any>("config.json", {}).read();
      const legacyContext = await ctx.storage.json<any>("context.json", {}).read();
      await db.update(data => { if (data.legacyImported) return data;
        const chats = {...((legacyMain?.chats && typeof legacyMain.chats === "object") ? legacyMain.chats : {}), ...data.chats};
        for (const [chatId, value] of Object.entries((legacyContext?.chats && typeof legacyContext.chats === "object") ? legacyContext.chats : {})) {
          const old = value as any; const target = chats[chatId] ?? empty();
          chats[chatId] = {...target, contextEnabled: !!old?.contextEnabled, turns: old?.contextTurns && typeof old.contextTurns === "object" ? old.contextTurns : target.turns};
        }
        return {schemaVersion: 1, chats, legacyImported: true}; }); },
    commands: {deepwiki: deepwikiCommand}});
}
