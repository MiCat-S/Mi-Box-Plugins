import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, ui, type CommandDefinition, type CommandInvocation, type PluginContext, type SubcommandDefinition} from "telebox/sdk";

type Entry={name:string;key:string;baseUrl:string;addedAt:number};
type State={schemaVersion:1;entries:Entry[];legacyImported:boolean;[key:string]:unknown};
const defaults:State={schemaVersion:1,entries:[],legacyImported:false};
const store=(c:PluginContext)=>c.storage.json<State>("keys-v2.json",defaults);
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[x]!);
const mask=(s:string)=>s.length<12?"***":`${s.slice(0,4)}…${s.slice(-4)}`;
function api(base:string,path:string){const u=new URL(base.includes("://")?base:`https://${base}`);if(!/^https?:$/.test(u.protocol)||u.username||u.password)throw new Error("API 地址无效");u.pathname=`${u.pathname.replace(/\/+$/,"")}${path}`;u.hash="";return u;}
async function bounded(r:Response,s:AbortSignal){const reader=r.body?.getReader();if(!reader)return"";const chunks:Buffer[]=[];let total=0;try{for(;;){s.throwIfAborted();const x=await reader.read();if(x.done)break;total+=x.value.length;if(total>1024*1024)throw new Error("API 响应过大");chunks.push(Buffer.from(x.value));}return Buffer.concat(chunks).toString("utf8");}finally{reader.releaseLock();}}
async function json(c:PluginContext,url:URL,init:RequestInit){return c.http.withResponse(url,init,async(r,s)=>{const text=await bounded(r,s);let data:unknown;try{data=JSON.parse(text);}catch{throw new Error("API 返回的不是 JSON");}if(!r.ok)throw new Error(`HTTP ${r.status}`);return data;},{timeoutMs:20_000,redirects:{allowedHosts:[url.hostname],maxRedirects:2}});}
function models(data:any):string[]{const rows=Array.isArray(data?.data)?data.data:Array.isArray(data?.models)?data.models:[];return rows.map((x:any)=>String(x?.id??x?.name??"")).filter(Boolean);}
function text(data:any){return String(data?.choices?.[0]?.message?.content??data?.candidates?.[0]?.content?.parts?.[0]?.text??"");}
async function resolve(c:PluginContext,input:string,base?:string){const state=await store(c).read();const saved=state.entries.find(x=>x.name===input);const key=saved?.key??input;const baseUrl=base??saved?.baseUrl;if(!key||!baseUrl)throw new Error("请提供已保存名称，或同时提供 URL 与 Key");return{key,baseUrl};}
async function migrate(c:PluginContext){const current=await store(c).read();if(current.legacyImported)return;let entries:Entry[]=[];try{const legacy=JSON.parse(await (await import("node:fs/promises")).readFile(c.files.dataPath("keys.json"),"utf8"));if(Array.isArray(legacy))entries=legacy.flatMap((x:any)=>typeof x?.name==="string"&&typeof x?.key==="string"&&typeof x?.baseUrl==="string"?[{name:x.name,key:x.key,baseUrl:x.baseUrl,addedAt:Number(x.addedAt)||Date.now()}]:[]);}catch{}await store(c).update(v=>({...v,schemaVersion:1,entries:v.entries.length?v.entries:entries,legacyImported:true}));}

async function run(invocation: CommandInvocation, c: PluginContext, body: () => Promise<void>) {
  try { await body(); }
  catch (e) { if (!c.signal.aborted) await c.telegram.edit(invocation.message, `❌ ${esc(e instanceof Error ? e.message : "请求失败")}`, { parseMode: "html" }); }
}

function inlineOf(args: readonly string[]) { return args[0]?.includes("://") && args[1] ? { base: args[0], key: args[1] } : undefined; }

const checkapiCommand: CommandDefinition = {
  description: "管理并检测 API",
  helpOnEmpty: true,
  helpArgs: ["help"],
  subcommandsCaseSensitive: false,
  subcommands: {
    save: {
      description: "保存或更新 API 连接（仅收藏夹）", args: "名称 URL Key",
      arguments: [{name: "名称", required: true}, {name: "URL", required: true, description: "API 基址，例如 https://api.example.com/v1"}, {name: "Key", required: true}],
      examples: [{args: "save demo https://api.example.com/v1 sk-example"}],
      async handle(invocation, c) { return run(invocation, c, async () => {
        if (!invocation.message.saved) throw new Error("密钥管理仅限收藏夹");
        const [name, baseUrl, key] = invocation.args;
        if (!name || !baseUrl || !key) throw new Error("用法：checkapi save 名称 URL Key");
        api(baseUrl, "/models");
        let replaced = false;
        await store(c).update(v => { const entries = v.entries.filter(x => x.name !== name); replaced = entries.length !== v.entries.length;
          return {...v, entries: [...entries, {name, key, baseUrl: baseUrl.replace(/\/+$/, "")!, addedAt: Date.now()}]}; });
        try { const target = api(baseUrl, "/models"); await json(c, target, {headers: {authorization: `Bearer ${key}`}}); }
        catch { await c.telegram.edit(invocation.message, `API ${replaced ? "配置已更新" : "已保存"}，验证失败；请检查地址或密钥。`); return; }
        await c.telegram.edit(invocation.message, `API ${replaced ? "配置已更新" : "已保存"}并验证成功。`);
      }); },
    },
    list: {
      description: "查看已保存连接", args: "", examples: [{args: "list"}],
      async handle(invocation, c) { return run(invocation, c, async () => {
        const s = await store(c).read();
        await c.telegram.edit(invocation.message, s.entries.length ? s.entries.map(x => `<b>${esc(x.name)}</b> ${esc(mask(x.key))} ${esc(new URL(x.baseUrl).hostname)}`).join("\n") : "尚未保存 API", {parseMode: "html"});
      }); },
    },
    del: {
      description: "删除指定连接", args: "名称",
      arguments: [{name: "名称", required: true}], examples: [{args: "del demo"}],
      async handle(invocation, c) { return run(invocation, c, async () => {
        const name = invocation.args[0];
        if (!name) throw new Error("请提供名称");
        let removed = false;
        await store(c).update(v => ({...v, entries: v.entries.filter(x => { if (x.name === name) { removed = true; return false; } return true; })}));
        await c.telegram.edit(invocation.message, removed ? "API 配置已删除。" : "未找到该配置。");
      }); },
    },
    check: {
      description: "验证模型接口", args: "名称|URL Key",
      arguments: [{name: "名称", description: "已保存名称，或直接填写 URL 与 Key"}],
      examples: [{args: "check demo"}, {args: "check https://api.example.com/v1 sk-example"}],
      async handle(invocation, c) { return run(invocation, c, async () => {
        const inline = inlineOf(invocation.args);
        const got = await resolve(c, inline?.key ?? invocation.args[0] ?? "check", inline?.base);
        const data = await json(c, api(got.baseUrl, "/models"), {headers: {authorization: `Bearer ${got.key}`}});
        const list = models(data);
        if (!list.length) throw new Error("API 响应缺少模型列表");
        await c.telegram.edit(invocation.message, `✅ API 有效，共 ${list.length} 个模型。`);
      }); },
    },
    models: {
      description: "显示完整模型列表", args: "名称|URL Key",
      arguments: [{name: "名称", description: "已保存名称，或直接填写 URL 与 Key"}],
      examples: [{args: "models demo"}],
      async handle(invocation, c) { return run(invocation, c, async () => {
        const inline = inlineOf(invocation.args);
        const got = await resolve(c, inline?.key ?? invocation.args[0] ?? "models", inline?.base);
        const data = await json(c, api(got.baseUrl, "/models"), {headers: {authorization: `Bearer ${got.key}`}});
        const list = models(data);
        if (!list.length) throw new Error("API 响应缺少模型列表");
        const pages = (await ui.renderDocument({title: "模型列表", subtitle: `${list.length} 个`, sections: [ui.section(undefined, list.map(name => ui.text(name)))]}, ui.PAGE_LABEL_RESERVE)).map((page, index, all) => page + ui.pageLabel(index, all.length));
        const delivery = await ui.deliverPages(pages, c.signal, (page, index) => index ? c.telegram.reply(invocation.message, page, {parseMode: "html"}) : c.telegram.edit(invocation.message, page, {parseMode: "html"}));
        if (delivery.interrupted) { c.log.info("pagination_delivery_interrupted", {plugin: "checkapi", published: delivery.published, total: delivery.total, category: ui.deliveryErrorCategory(delivery.error)}); if (!delivery.published) throw delivery.error; try { await c.telegram.reply(invocation.message, ui.interruptedNotice(delivery), {parseMode: "html"}); } catch {} }
      }); },
    },
    ask: {
      description: "发送一次测试提问", args: "名称|URL Key [问题]",
      arguments: [{name: "名称", description: "已保存名称，或直接填写 URL 与 Key"}, {name: "问题", description: "省略时发送 say hello"}],
      examples: [{args: "ask demo 用一句话打招呼"}],
      async handle(invocation, c) { return run(invocation, c, async () => {
        const inline = inlineOf(invocation.args);
        const prompt = invocation.args.slice(inline ? 2 : 1).join(" ") || "say hello";
        const got = await resolve(c, inline?.key ?? invocation.args[0] ?? "ask", inline?.base);
        const data = await json(c, api(got.baseUrl, "/chat/completions"), {method: "POST", headers: {authorization: `Bearer ${got.key}`, "content-type": "application/json"},
          body: JSON.stringify({model: "gpt-4o-mini", messages: [{role: "user", content: prompt}], max_tokens: 100})});
        const output = text(data);
        if (!output) throw new Error("API 响应缺少消息内容");
        await c.telegram.edit(invocation.message, esc(output), {parseMode: "html"});
      }); },
    },
  },
  examples: [{args: "save demo https://api.example.com/v1 sk-example"}, {args: "check demo"}, {args: "models demo"}, {args: "ask demo 用一句话打招呼"}],
  help: [
    {heading: "连接管理：", body: "save 保存或更新同名连接并验证模型接口（仅限收藏夹）；list 查看名称、主机与遮罩密钥；del 删除指定连接。"},
    {heading: "参数与限制：", body: "名称不含空格，按保存的名称匹配。URL 填 API 基址，插件在其后追加 <code>/models</code> 或 <code>/chat/completions</code>。ask 固定使用 gpt-4o-mini，输出上限 100 tokens；单次 HTTP 请求限时 20 秒，响应体上限 1 MiB。保存后验证失败时连接仍已保存。"},
    {heading: "常见提示：", body: "要求提供已保存名称时先 list 核对；HTTP 错误检查基址、密钥与接口权限；响应缺少模型或消息内容时检查接口兼容性。模型列表成功不代表测试模型可用；包含密钥的内联命令请在收藏夹执行。"},
  ],
  async handle(invocation, c) {
    if (!invocation.args.length || invocation.args[0]!.toLowerCase() === "help") {
      await c.telegram.edit(invocation.message, renderCommandHelp("checkapi", checkapiCommand, {prefix: invocation.prefix, title: "🔑 API 检测工具"}), {parseMode: "html"});
      return;
    }
    await run(invocation, c, async () => {
      const args = invocation.args;
      const inline = args[1]?.includes("://") && args[2] ? {base: args[1], key: args[2]} : undefined;
      await resolve(c, inline?.key ?? args[1] ?? args[0] ?? "", inline?.base);
      throw new Error("未知子命令");
    });
  },
};

export default function createCheckapi() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "checkapi", description: "验证 OpenAI 兼容 API、模型与对话",
    renderHelp: prefix => renderCommandHelp("checkapi", checkapiCommand, {prefix, title: "🔑 API 检测工具"}),
    commands: {checkapi: checkapiCommand},
    settings: c => ({id: "checkapi", title: "API 检查", description: "保存的 API 连接（密钥字段受秘密设置保护）", category: "插件配置", icon: "🔑",
      getSchema: () => [{key: "entries", label: "API 连接", type: "provider-list", secret: true}],
      getValues: async () => ({entries: (await store(c).read()).entries}),
      setValues: async p => { if (!Array.isArray(p.entries)) throw new Error("invalid entries");
        const entries = p.entries.flatMap((x: any) => typeof x?.name === "string" && typeof x?.key === "string" && typeof x?.baseUrl === "string" ? [{name: x.name, key: x.key, baseUrl: x.baseUrl, addedAt: Number(x.addedAt) || Date.now()}] : []);
        for (const x of entries) api(x.baseUrl, "/models");
        await store(c).update(v => ({...v, entries})); }}),
    setup: migrate});
}
