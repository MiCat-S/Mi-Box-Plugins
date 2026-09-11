import {
  STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, ui,
  type CommandDefinition, type CommandInvocation, type PluginContext,
} from "telebox/sdk";

type LegacyEntry = {name:string;key:string;baseUrl:string;addedAt?:number};
type MigrationState = {schemaVersion:number;entries:LegacyEntry[];legacyImported:boolean;aiMigrated?:boolean;[key:string]:unknown};
const migrationDefaults: MigrationState = {schemaVersion:2,entries:[],legacyImported:false,aiMigrated:false};
const migrationStore = (context:PluginContext) => context.storage.json<MigrationState>("keys-v2.json",migrationDefaults);

type Selection = {providers?: Array<{tag?:string;type?:string;models?:Record<string,string>}>};
const esc = (value:unknown): string => String(value ?? "").replace(/[&<>"']/g,
  character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]!);

async function run(invocation: CommandInvocation, context: PluginContext, operation: () => Promise<void>): Promise<void> {
  try {await migrate(context);await operation();}
  catch {if (!context.signal.aborted) await context.telegram.edit(invocation.message,
    "❌ API 检测失败，请检查 ai 插件中的标签、模型、凭据和接口兼容性");}
}
function requireService(context: PluginContext, service: string): void {
  if (!context.services.available("ai", service)) throw new Error("AI service unavailable");
}
const central = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
  await context.telegram.edit(invocation.message,
    `API 连接由 ai 插件统一管理，请使用 ${invocation.prefix}ai config add、${invocation.prefix}ai config del 与 ${invocation.prefix}ai model chat。`);
};
async function tags(context: PluginContext): Promise<Array<{tag:string;type:string;models:Record<string,string>}>> {
  requireService(context, "selection");
  const selection = await context.services.call<Selection>("ai", "selection", null, context.signal);
  return (selection.providers ?? []).flatMap(item => typeof item.tag === "string" && item.tag ? [{tag:item.tag,
    type:typeof item.type === "string" ? item.type : "auto", models:item.models && typeof item.models === "object" ? item.models : {}}] : []);
}
async function modelList(context: PluginContext, tag: string): Promise<string[]> {
  requireService(context, "models");
  if (!tag) throw new Error("missing tag");
  return context.services.call<string[]>("ai", "models", {tag}, context.signal);
}

function legacyEntry(value:unknown): LegacyEntry | undefined {
  if (!value || typeof value !== "object") return;
  const item=value as Record<string,unknown>;
  if (typeof item.name!=="string" || typeof item.key!=="string" || typeof item.baseUrl!=="string" || !item.key) return;
  try {const target=new URL(item.baseUrl); if (!["https:","http:"].includes(target.protocol) || target.username || target.password) return;}
  catch {return;}
  return {name:item.name,key:item.key,baseUrl:item.baseUrl,...(Number.isFinite(Number(item.addedAt))?{addedAt:Number(item.addedAt)}:{})};
}
async function migrate(context:PluginContext):Promise<void> {
  let current=await migrationStore(context).read(context.signal);
  if (!current.legacyImported) {
    let entries:LegacyEntry[]=[];
    try {const legacy=JSON.parse(await import("node:fs/promises").then(fs=>fs.readFile(context.files.dataPath("keys.json"),"utf8")));
      if (Array.isArray(legacy)) entries=legacy.flatMap(item=>{const parsed=legacyEntry(item);return parsed?[parsed]:[];});} catch {}
    current=await migrationStore(context).update(value=>({...value,schemaVersion:2,entries:value.entries?.length?value.entries:entries,legacyImported:true,aiMigrated:value.aiMigrated===true}),context.signal);
  }
  if (current.aiMigrated) return;
  const entries=(Array.isArray(current.entries)?current.entries:[]).flatMap(item=>{const parsed=legacyEntry(item);return parsed?[parsed]:[];});
  if (!entries.length) {await migrationStore(context).update(value=>({...value,entries:[],aiMigrated:true}),context.signal);return;}
  if (!context.services.available("ai","import_provider")) return;
  for (let index=0;index<entries.length;index++) {
    const entry=entries[index]!;const safe=entry.name.replace(/[^A-Za-z0-9._-]/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"");
    await context.services.call("ai","import_provider",{tag:(safe||`checkapi-${index+1}`).slice(0,64),url:entry.baseUrl,key:entry.key,
      type:"openai-compatible",models:{chat:"gpt-4o-mini"},select:index===0?["chat"]:[]},context.signal);
  }
  await migrationStore(context).update(value=>({...value,entries:[],aiMigrated:true}),context.signal);
  try {await context.tasks.run("checkapi:legacy-scrub", async () => {
    const {writeFile}=await import("node:fs/promises"); await writeFile(context.files.dataPath("keys.json"),"[]","utf8");
  });} catch {}
}

const checkapiCommand: CommandDefinition = {
  description:"检测 ai 插件统一管理的 API", helpOnEmpty:true, helpArgs:["help"], subcommandsCaseSensitive:false,
  subcommands:{
    save:{description:"查看统一 AI 配置方式",handle:central},
    del:{description:"查看统一 AI 配置方式",handle:central},
    list:{description:"查看 ai 插件中的提供商标签",async handle(invocation,context){return run(invocation,context,async()=>{
      const list=await tags(context);
      await context.telegram.edit(invocation.message,list.length?list.map(item=>`<b>${esc(item.tag)}</b> · ${esc(item.type)}${Object.keys(item.models).length?` · ${esc(Object.entries(item.models).map(([mode,model])=>`${mode}=${model}`).join(" · "))}`:""}`).join("\n"):"ai 插件中尚未配置 API",{parseMode:"html"});
    });}},
    check:{description:"验证指定 ai 提供商的模型接口",args:"标签",arguments:[{name:"标签",required:true}],examples:[{args:"check main"}],
      async handle(invocation,context){return run(invocation,context,async()=>{const list=await modelList(context,invocation.args[0]??"");await context.telegram.edit(invocation.message,`✅ API 有效，共 ${list.length} 个模型。`);});}},
    models:{description:"显示指定 ai 提供商的完整模型列表",args:"标签",arguments:[{name:"标签",required:true}],examples:[{args:"models main"}],
      async handle(invocation,context){return run(invocation,context,async()=>{
        const tag=invocation.args[0]??"",list=await modelList(context,tag);
        const pages=(await ui.renderDocument({title:"模型列表",subtitle:`${tag} · ${list.length} 个`,sections:[ui.section(undefined,list.map(name=>ui.text(name)))]},ui.PAGE_LABEL_RESERVE)).map((page,index,all)=>page+ui.pageLabel(index,all.length));
        const delivery=await ui.deliverPages(pages,context.signal,(page,index)=>index?context.telegram.reply(invocation.message,page,{parseMode:"html"}):context.telegram.edit(invocation.message,page,{parseMode:"html"}));
        if(delivery.interrupted){context.log.info("pagination_delivery_interrupted",{plugin:"checkapi",published:delivery.published,total:delivery.total,category:ui.deliveryErrorCategory(delivery.error)});if(!delivery.published)throw delivery.error;try{await context.telegram.reply(invocation.message,ui.interruptedNotice(delivery),{parseMode:"html"});}catch{}}
      });}},
    ask:{description:"使用指定 ai 提供商发送一次测试提问",args:"标签 [问题]",arguments:[{name:"标签",required:true},{name:"问题",description:"省略时发送 say hello"}],examples:[{args:"ask main 用一句话打招呼"}],
      async handle(invocation,context){return run(invocation,context,async()=>{
        requireService(context,"chat");const tag=invocation.args[0]??"";if(!tag)throw new Error("missing tag");
        const output=await context.services.call<string>("ai","chat",{tag,text:invocation.args.slice(1).join(" ")||"say hello",maxOutputTokens:100},context.signal);
        await context.telegram.edit(invocation.message,esc(output),{parseMode:"html"});
      });}},
  },
  examples:[{args:"list"},{args:"check main"},{args:"models main"},{args:"ask main 用一句话打招呼"}],
  help:[
    {heading:"统一配置：",body:"API 地址、密钥、类型与模型由 ai 插件统一管理；本插件只读取标签并执行模型列表或对话检测。"},
    {heading:"参数与限制：",body:"check、models 和 ask 的第一个参数都是 ai 配置标签。ask 默认使用该标签的聊天模型，输出上限为 100 tokens。"},
  ],
  async handle(invocation,context){
    if(!invocation.args.length||invocation.args[0]!.toLowerCase()==="help"){await context.telegram.edit(invocation.message,renderCommandHelp("checkapi",checkapiCommand,{prefix:invocation.prefix,title:"🔑 API 检测工具"}),{parseMode:"html"});return;}
    await run(invocation,context,async()=>{throw new Error("unknown subcommand");});
  },
};

export default function createCheckapi(){
  return definePlugin({apiVersion:STRUCTURED_PLUGIN_API_VERSION,id:"checkapi",description:"检测 ai 插件统一管理的 API、模型与对话",
    renderHelp:prefix=>renderCommandHelp("checkapi",checkapiCommand,{prefix,title:"🔑 API 检测工具"}),commands:{checkapi:checkapiCommand},setup:migrate});
}
