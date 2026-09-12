import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type PluginContext, type SubcommandDefinition} from "telebox/sdk";
import {collectWords, buildWordItems, renderWordCloud} from "./v2/wordcloud";
import {readFile} from "node:fs/promises";

type State={schemaVersion:1;enabled:boolean;target:string;times:string[];limit:number;lastRunKeys:string[];importedLegacy:boolean;[key:string]:unknown};
const defaults:State={schemaVersion:1,enabled:false,target:"",times:[],limit:500,lastRunKeys:[],importedLegacy:false};
const store=(c:PluginContext)=>c.storage.json<State>("schedule.json",defaults),valid=(v:string)=>/^([01]\d|2[0-3]):[0-5]\d$/.test(v),limit=(v:unknown,f=500)=>Math.max(50,Math.min(2000,Number.isFinite(Number(v))?Math.floor(Number(v)):f));
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[x]!);
function normalize(v:any):State{return{...v,schemaVersion:1,enabled:v?.enabled===true,target:typeof v?.target==="string"?v.target.trim():"",times:Array.isArray(v?.times)?[...new Set(v.times.map(String).filter(valid))].slice(0,12):[],limit:limit(v?.limit),lastRunKeys:Array.isArray(v?.lastRunKeys)?v.lastRunKeys.map(String).slice(-40):[],importedLegacy:true};}
async function migrate(c:PluginContext){const cur=await store(c).read();if(cur.importedLegacy&&cur.schemaVersion===1)return;let source:any=cur;try{source={...JSON.parse(await readFile(c.files.dataPath("cy_schedule.json"),"utf8")),...cur};}catch{}await store(c).update(()=>normalize(source));}
async function generate(c:PluginContext,target:any,count:number){return c.telegram.withClient(async(client,signal)=>{
  const counts=new Map<string,number>();let valid=0;
  for await(const raw of client.iterMessages(target,{limit:count})){
    signal.throwIfAborted();
    const text=String(raw?.text||raw?.message||"").trim();
    if(!text||raw?.sticker||c.commands.parse(text))continue;
    valid++;collectWords(text,counts);
  }
  const items=buildWordItems(counts);
  if(!items.length)throw new Error("insufficient_words");
  return renderWordCloud(items,count,valid);
});}
async function send(c:PluginContext,target:any,count:number,replyTo?:number){const png=await generate(c,target,count);if(png.length>10*1024*1024)throw new Error("output_too_large");await c.telegram.withClient(async client=>{const {CustomFile}=await import("teleproto/client/uploads.js");await client.sendFile(target,{file:new CustomFile("cy-wordcloud.png",png.length,"",png),replyTo});});}
function status(s:State){return `词云定时：${s.enabled?"on":"off"}\n目标：${s.target||"未设置"}\n时间：${s.times.join(", ")||"未设置"}\n数量：${s.limit}`;}

export default function createCy(){
  const runGenerate = async (invocation: any, c: PluginContext, count: number, target: any) => {
    const message = invocation.message;
    await c.telegram.edit(message, `正在统计最近 ${count} 条消息…`);
    try {
      await send(c, target, count, message.replyToId ?? message.id);
      await c.telegram.withClient(async (_client, signal) => { const raw = message.raw as any; if (typeof raw?.delete === "function") {
        try { await raw.delete({revoke: true}); } catch { if (!signal.aborted) c.log.info("cy_receipt_cleanup_failed"); } } });
    } catch {
      if (!c.signal.aborted) await c.telegram.edit(message, "没有统计到足够的热词，或词云生成失败");
    }
  };
  const cyCommand: CommandDefinition = {
    description: "立即或定时生成词云",
    args: "[数量]",
    arguments: [{name: "数量", description: "统计最近消息数，50–2000，默认 500"}],
    helpArgs: ["help", "?"],
    ignoreEdited: true,
    subcommandsCaseSensitive: false,
    subcommands: {
      target: {
        description: "设置定时发送目标", args: "here|目标", examples: [{args: "target here"}, {args: "target @群用户名"}],
        arguments: [{name: "目标", description: "here 表示当前对话"}],
        async handle(invocation, c) {
          const message = invocation.message;
          const target = !invocation.args[0] || invocation.args[0] === "here" ? message.chatId : invocation.args[0];
          await store(c).update(v => normalize({...v, target}));
          await c.telegram.edit(message, `词云目标已设置：${esc(target)}`);
        },
      },
      time: {
        description: "设置定时时间与数量", args: "HH:MM[,HH:MM] [数量]", examples: [{args: "time 09:00 500"}, {args: "time 09:00,21:30 1000"}, {args: "time 05:00 12:00 21:30 2000"}],
        arguments: [{name: "时间", required: true, description: "一个或多个 HH:MM，可用逗号分隔"}, {name: "数量", description: "可选，50–2000"}],
        async handle(invocation, c) {
          const message = invocation.message;
          const values = invocation.args.flatMap(x => x.split(","));
          const times = values.filter(valid), numeric = values.find(x => /^\d+$/.test(x));
          if (!times.length || values.some(x => !valid(x) && !/^\d+$/.test(x))) {
            await c.telegram.edit(message, `用法：${invocation.prefix}cy time 09:00,21:30 [数量]`);
            return;
          }
          let next!: State;
          await store(c).update(value => {
            const state = normalize(value);
            next = normalize({...state, times, limit: numeric ? limit(numeric, state.limit) : state.limit});
            return next;
          });
          await c.telegram.edit(message, status(next));
        },
      },
      on: {
        description: "开启定时任务", args: "", examples: [{args: "on"}],
        async handle(invocation, c) {
          let next!: State, changed = false;
          await store(c).update(value => {
            const state = normalize(value);
            next = normalize({...state, enabled: true});
            if (!next.target || !next.times.length) return state;
            changed = true;
            return next;
          });
          if (!changed) { await c.telegram.edit(invocation.message, "请先设置目标和时间"); return; }
          await c.telegram.edit(invocation.message, status(next));
        },
      },
      off: {
        description: "关闭定时任务", args: "", examples: [{args: "off"}],
        async handle(invocation, c) {
          let next!: State;
          await store(c).update(value => (next = normalize({...normalize(value), enabled: false})));
          await c.telegram.edit(invocation.message, status(next));
        },
      },
      status: {
        description: "查看定时配置", args: "", aliases: ["config"], examples: [{args: "status"}],
        async handle(invocation, c) { await c.telegram.edit(invocation.message, status(normalize(await store(c).read()))); },
      },
      send: {
        description: "按定时目标立即发送", args: "[数量]", aliases: ["now"], examples: [{args: "send"}, {args: "send 300"}],
        async handle(invocation, c) {
          const state = normalize(await store(c).read());
          const count = limit(invocation.args[0], state.limit);
          await runGenerate(invocation, c, count, state.target || invocation.message.chatId);
        },
      },
    },
    examples: [{args: ""}, {args: "500"}, {args: "send"}, {args: "target here"}, {args: "time 09:00 500"}, {args: "on"}, {args: "off"}, {args: "status"}],
    help: [
      {heading: "说明：", body: "立即生成会统计当前对话最近的消息并发送词云；设置 target 与 time 后可用 on/off 启用定时发送。"},
    ],
    async handle(invocation, c) {
      const state = normalize(await store(c).read());
      const sub = invocation.args[0]?.toLowerCase();
      if (sub === "help" || sub === "?") {
        await c.telegram.edit(invocation.message, renderCommandHelp("cy", cyCommand, {prefix: invocation.prefix, title: "词云 cy"}), {parseMode: "html"});
        return;
      }
      const count = limit(sub, state.limit);
      await runGenerate(invocation, c, count, invocation.message.chatId);
    },
  };
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "cy", description: "统计聊天热词并生成词云",
    renderHelp: prefix => renderCommandHelp("cy", cyCommand, {prefix, title: "词云 cy"}),
    commands: {cy: cyCommand},
    jobs: {scheduled_cloud: {description: "发送定时词云", cron: "* * * * *", timeZone: "Asia/Shanghai", async handle(c, signal) {
      const state = normalize(await store(c).read());
      if (!state.enabled || !state.target || !state.times.length) return;
      const parts = new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts();
      const get = (t: string) => parts.find(x => x.type === t)?.value ?? "";
      const time = `${get("hour")}:${get("minute")}`, key = `${get("year")}-${get("month")}-${get("day")}:${time}`;
      if (!state.times.includes(time) || state.lastRunKeys.includes(key)) return;
      signal.throwIfAborted();
      await send(c, state.target, state.limit);
      await store(c).update(v => normalize({...v, lastRunKeys: [...normalize(v).lastRunKeys, key].slice(-40)}));
    }}},
    settings: c => ({id: "cy", title: "词云", description: "词云定时任务配置", category: "插件配置", icon: "☁️",
      getSchema: () => [{key: "enabled", label: "启用定时", type: "boolean"}, {key: "target", label: "目标聊天", type: "string"}, {key: "times", label: "执行时间", type: "json"}, {key: "limit", label: "消息数量", type: "number", min: 50, max: 2000}],
      getValues: () => store(c).read(),
      setValues: async patch => { await store(c).update(v => normalize({...v, ...patch})); }}),
    setup: migrate});
}
