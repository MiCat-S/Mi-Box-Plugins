import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";
import {returnBigInt} from "teleproto/Helpers.js";

type Target = {id: string; target: string; chatId?: string; topicId?: string; display?: string; status?: "0"; createdAt: string; updatedAt?: string; [key: string]: unknown};
type State = {schemaVersion: number; seq: string; mode: "sequence" | "broadcast"; targets: Target[]; [key: string]: unknown};
class FloodRetryError extends Error {}
const MAX_FLOOD_WAIT_MS=60_000;
const defaults = (): State => ({schemaVersion: 1, seq: "0", mode: "sequence", targets: []});
const store = (context: PluginContext) => context.storage.json<State>("config.json", defaults());
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function normalize(source: State): State {
  const targets = Array.isArray(source.targets) ? source.targets.filter(value => value && typeof value.target === "string").map(value => {
    const normalized={...value,id:String(value.id),target:String(value.target),createdAt:String(value.createdAt??Date.now())};
    if(value.chatId===undefined)delete normalized.chatId;else normalized.chatId=String(value.chatId);
    if(value.topicId===undefined)delete normalized.topicId;else normalized.topicId=String(value.topicId);
    return normalized;
  }) : [];
  const maximum = targets.reduce((max, value) => Math.max(max, Number(value.id) || 0), 0);
  return {...source, schemaVersion: 1, seq: String(Math.max(maximum, Number(source.seq) || 0)),
    mode: source.mode === "broadcast" ? "broadcast" : "sequence", targets};
}

function lookup(target: Target): string | ReturnType<typeof returnBigInt> {
  const value = target.chatId ?? target.target;
  if (/^-?\d+$/.test(value)) return returnBigInt(value);
  return value;
}

function entityName(entity: any): string {
  return entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") || entity?.username && `@${entity.username}` || "来源对话";
}

function entityId(entity: any): string | undefined {
  const raw=entity?.id??entity?.channelId??entity?.chatId??entity?.userId;
  if(raw===undefined)return;
  return String(raw).replace(/^-100/,"").replace(/^-/g,"");
}

function messageLink(entity:any,id:number):string|undefined {
  const username=typeof entity?.username==="string"&&entity.username.trim();
  if(username)return `https://t.me/${username}/${id}`;
  const value=entityId(entity);if(!value)return;
  return entity?.className==="User"?`tg://user?id=${value}`:`https://t.me/c/${value}/${id}`;
}
function entityLink(entity:any):string|undefined {
  const username=typeof entity?.username==="string"&&entity.username.trim();if(username)return `https://t.me/${username}`;
  const value=entityId(entity);if(!value)return;
  return entity?.className==="User"?`tg://user?id=${value}`:`https://t.me/c/${value}`;
}
function linkTags(entity:any,ids:number[]):string {
  return ids.map((id,index)=>{const url=messageLink(entity,id);return url?`<a href="${escape(url)}">#${index+1}</a>`:`#${index+1}`;}).join(" ");
}
function floodWait(error:unknown):number|undefined {
  const text=String((error as any)?.errorMessage??(error as any)?.message??"");
  const match=text.match(/(?:^|\b)FLOOD_WAIT_(\d+)(?:\b|$)/);if(!match)return;
  return (Number(match[1])+1)*1000;
}
function wait(ms:number,signal:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(signal.reason);return;}const timer=setTimeout(done,ms);
  function done(){signal.removeEventListener("abort",abort);resolve();}
  function abort(){clearTimeout(timer);reject(signal.reason);}
  signal.addEventListener("abort",abort,{once:true});
});}

function list(state: State): string {
  const rows = state.targets.slice().sort((a, b) => Number(a.id) - Number(b.id)).map(value =>
    `${value.status === "0" ? "⏹" : "🔛"} [<code>${escape(value.id)}</code>] ${value.display || `<code>${escape(value.target)}</code>`}` +
    (value.topicId ? ` | 话题 <code>${escape(value.topicId)}</code>` : ""));
  return `<b>保送目标</b>\n模式：<b>${state.mode === "broadcast" ? "群发" : "顺序"}</b>\n\n${rows.join("\n") || "暂无目标"}`;
}

function help(prefix: string): string {
  return `<b>保送插件</b>\n<code>${prefix}bs [数量]</code> 回复消息后转发\n` +
    `<code>${prefix}bs add 目标[|话题ID]</code>\n<code>${prefix}bs list</code>\n` +
    `<code>${prefix}bs del ID</code> · <code>${prefix}bs enable ID</code> · <code>${prefix}bs disable ID</code>\n` +
    `<code>${prefix}bs toggle mode</code>`;
}

function forwarded(result: any): any[] {
  return Array.isArray(result?.updates) ? result.updates.map((value: any) => value?.message).filter((value: any) => value?.className === "Message") : [];
}

async function forward(invocation: any, context: PluginContext, count: number): Promise<void> {
  const reply = await context.telegram.getReply(invocation.message);
  if (!reply) { await context.telegram.edit(invocation.message, "请回复需要保送的消息"); return; }
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) { await context.telegram.edit(invocation.message, "消息数必须是 1 到 100 的整数"); return; }
  const state = normalize(await store(context).read());
  const targets = state.targets.filter(value => value.status !== "0");
  if (!targets.length) { await context.telegram.edit(invocation.message, "尚未配置可用目标"); return; }
  await context.telegram.edit(invocation.message, "正在保送消息…");
  try {
    const successes: {target:Target;entity:any;messages:any[]}[] = [];
    const failures: string[] = [];
    const throttled: string[] = [];
    await context.telegram.withClient(async (client, signal) => {
      const {Api} = await import("teleproto");
      const raw = invocation.message.raw as ApiTypes.Message | undefined;
      const replied = reply.raw as ApiTypes.Message | undefined;
      if (!replied) throw new Error("Missing source");
      const sourcePeer=raw?.peerId??returnBigInt(invocation.message.chatId);
      const values: any[] = [];
      for (let id = replied.id; values.length < count && id < replied.id + count * 3; id++) {
        signal.throwIfAborted();
        const result = await client.getMessages(sourcePeer, {ids: [id]});
        const message = Array.isArray(result) ? result[0] : result;
        if (message?.id) values.push(message.id);
      }
      if (!values.length) throw new Error("No messages");
      for (const target of targets) {
        signal.throwIfAborted();
        try {
          const entity: any = await client.getEntity(lookup(target) as any);
          signal.throwIfAborted();
          const input = await client.getInputEntity(entity);
          signal.throwIfAborted();
          let result:any;
          for(let attempt=0;attempt<2;attempt++){
            signal.throwIfAborted();
            try{result=await client.invoke(new Api.messages.ForwardMessages({fromPeer: sourcePeer, id: values, toPeer: input,
              ...(target.topicId && /^\d+$/.test(target.topicId) ? {topMsgId: Number(target.topicId)} : {})}));break;}
            catch(error){const delay=floodWait(error);if(delay===undefined)throw error;
              if(delay>MAX_FLOOD_WAIT_MS||attempt===1)throw new FloodRetryError();await wait(delay,signal);}
          }
          signal.throwIfAborted();
          const messages = forwarded(result);
          successes.push({target,entity,messages});
          if (state.mode === "sequence") break;
        } catch(error) {signal.throwIfAborted();const name=target.display||target.target;
          if(error instanceof FloodRetryError)throttled.push(name);else failures.push(name);}
      }
      if(successes.length){
        let sourceEntity:any;
        signal.throwIfAborted();
        try{sourceEntity=await client.getEntity(sourcePeer);signal.throwIfAborted();}
        catch{signal.throwIfAborted();context.log.error("bs_source_entity_failed");}
        for(const success of successes){
          signal.throwIfAborted();
          const first=success.messages[0];if(!first?.id)continue;
          const sourceName=escape(entityName(sourceEntity));
          const sourceUrl=entityLink(sourceEntity);
          const source=sourceUrl?`<a href="${escape(sourceUrl)}">${sourceName}</a>`:sourceName;
          const sentIds=success.messages.map(message=>message?.id).filter((id):id is number=>typeof id==="number");
          const original=linkTags(sourceEntity,values.slice(0,sentIds.length));
          const sent=linkTags(success.entity,sentIds);
          try{await client.sendMessage(success.entity,{message:`来源：${source}<br>原消息：${original}<br>消息：${sent}`,parseMode:"html",linkPreview:false,replyTo:first.id,
            ...(success.target.topicId&&/^\d+$/.test(success.target.topicId)?{topMsgId:Number(success.target.topicId)}:{})});}
          catch{signal.throwIfAborted();context.log.error("bs_target_feedback_failed");}
        }
      }
    });
    if (!successes.length) { await context.telegram.edit(invocation.message, throttled.length ? `操作频繁，请稍后重试：${throttled.map(escape).join("、")}` : `保送失败${failures.length ? `：${failures.map(escape).join("、")}` : ""}`); return; }
    await context.telegram.edit(invocation.message, `已保送至：${successes.map(value=>escape(`${value.target.display || value.target.target}（${value.messages.length || count} 条）`)).join("、")}`+
      (throttled.length?`；限流：${throttled.map(escape).join("、")}`:""));
  } catch(error) {
    if (context.signal.aborted) return;
    context.log.error("bs_forward_failed");
    await context.telegram.edit(invocation.message, error instanceof FloodRetryError ? "操作频繁，请稍后重试" : "保送失败，请检查目标权限或稍后重试");
  }
}

export default function createBs() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "bs", description: "将回复消息保送至已配置目标",
    async setup(context) { await store(context).update(normalize); },
    commands: {bs: {helpArgs: ["help","h","说明"], description: "管理目标或保送回复消息", async handle(invocation: any, context: PluginContext) {
      const command = (invocation.args[0] ?? "").toLowerCase();
      if (!command || /^\d+$/.test(command)) return forward(invocation, context, command ? Number(command) : 1);
      if (["help", "h", "说明"].includes(command)) { await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"}); return; }
      if (["list", "ls"].includes(command)) { await context.telegram.edit(invocation.message, list(normalize(await store(context).read())), {parseMode: "html", linkPreview: false}); return; }
      if (command === "add") {
        const rawTarget = invocation.args.slice(1).join(" ").trim();
        const [target, topicId] = rawTarget.split(/\s*[|｜]\s*/, 2);
        if (!target) { await context.telegram.edit(invocation.message, "请提供目标对话"); return; }
        try {
          let resolved: any;
          await context.telegram.withClient(async client => { resolved = await client.getEntity(/^-?\d+$/.test(target) ? BigInt(target) : target); });
          const state = await store(context).update(source => {
            const value = normalize(source); const id = String(Number(value.seq) + 1); value.seq = id;
            value.targets.push({id, target, chatId: resolved?.id?.toString(), topicId: /^\d+$/.test(topicId ?? "") ? topicId : undefined,
              display: resolved?.title || [resolved?.firstName, resolved?.lastName].filter(Boolean).join(" ") || resolved?.username && `@${resolved.username}` || target,
              createdAt: String(Date.now())}); return value;
          });
          await context.telegram.edit(invocation.message, `目标 <code>${state.seq}</code> 已添加`, {parseMode: "html"});
        } catch { await context.telegram.edit(invocation.message, "无法解析目标对话"); }
        return;
      }
      if (command === "toggle" && invocation.args[1]?.toLowerCase() === "mode") {
        const state = await store(context).update(source => { const value = normalize(source); value.mode = value.mode === "sequence" ? "broadcast" : "sequence"; return value; });
        await context.telegram.edit(invocation.message, `模式已切换为${state.mode === "broadcast" ? "群发" : "顺序"}`); return;
      }
      const id = invocation.args[1];
      const actions: Record<string, "remove" | "on" | "off"> = {rm: "remove", del: "remove", enable: "on", on: "on", disable: "off", off: "off"};
      if (actions[command] && id) {
        let found = false;
        await store(context).update(source => { const state = normalize(source); const target = state.targets.find(value => value.id === id);
          if (!target) return state; found = true;
          if (actions[command] === "remove") state.targets = state.targets.filter(value => value.id !== id);
          else if (actions[command] === "off") target.status = "0"; else delete target.status;
          return state; });
        await context.telegram.edit(invocation.message, found ? "目标状态已更新" : "目标不存在"); return;
      }
      await context.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
    }}},
  });
}
