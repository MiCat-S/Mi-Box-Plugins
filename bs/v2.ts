import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type PluginContext} from "telebox/sdk";
import type {Api as ApiTypes} from "teleproto";
import {returnBigInt} from "teleproto/Helpers.js";

type Target = {id: string; target: string; chatId?: string; topicId?: string; display?: string; createdAt: string; updatedAt?: string; [key: string]: unknown};
type State = {schemaVersion: number; targets: Target[]; [key: string]: unknown};
class FloodRetryError extends Error {}
class ForwardRestrictedError extends Error {}
class SourceMissingError extends Error {}
class NoMessagesError extends Error {}
const MAX_FLOOD_WAIT_MS=60_000;
const MAX_SEARCH=500;
const defaults = (): State => ({schemaVersion: 1, targets: []});
const store = (context: PluginContext) => context.storage.json<State>("config.json", defaults());
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>\"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#x27;"})[character]!);

function normalize(source: State): State {
  const targets = Array.isArray(source.targets) ? source.targets.filter(value => value && typeof value.target === "string").map(value => {
    const normalized={...value,id:String(value.id),target:String(value.target),createdAt:String(value.createdAt??Date.now())};
    if(value.chatId===undefined)delete normalized.chatId;else normalized.chatId=String(value.chatId);
    if(value.topicId===undefined)delete normalized.topicId;else normalized.topicId=String(value.topicId);
    if(value.display!==undefined)normalized.display=String(value.display);
    return normalized;
  }) : [];
  return {...source, schemaVersion: 1, targets};
}

function lookup(target: Target): string | ReturnType<typeof returnBigInt> {
  const value = target.chatId ?? target.target;
  if (/^-?\d+$/.test(value)) return returnBigInt(value);
  return value;
}

function entityName(entity: any, fallback: string): string {
  return entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") || entity?.username && `@${entity.username}` || fallback;
}

function entityId(entity:any): string | undefined {
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
function restrictedError(error:unknown):boolean {
  const text=String((error as any)?.errorMessage??(error as any)?.message??"");
  return text.includes("CHAT_FORWARDS_RESTRICTED");
}
function wait(ms:number,signal:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(signal.reason);return;}const timer=setTimeout(done,ms);
  function done(){signal.removeEventListener("abort",abort);resolve();}
  function abort(){clearTimeout(timer);reject(signal.reason);}
  signal.addEventListener("abort",abort,{once:true});
});}

function forwarded(result: any): any[] {
  return Array.isArray(result?.updates) ? result.updates.map((value: any) => value?.message).filter((value: any) => value?.className === "Message") : [];
}

async function forward(invocation: any, context: PluginContext, count: number): Promise<void> {
  const reply = await context.telegram.getReply(invocation.message);
  if (!reply) { await context.telegram.edit(invocation.message, "请回复需要保送的消息"); return; }
  if (!Number.isSafeInteger(count) || count < 1) { await context.telegram.edit(invocation.message, `❌ <b>消息数必须是正整数</b>\n示例：<code>${escape(invocation.prefix)}bs 3</code>`, {parseMode: "html"}); return; }
  const state = normalize(await store(context).read());
  const targets = state.targets;
  if (!targets.length) { await context.telegram.edit(invocation.message, "尚未配置目标频道\n请手动编辑配置文件 config.json"); return; }
  await context.telegram.edit(invocation.message, "正在保送消息…");
  try {
    await context.telegram.withClient(async (client, signal) => {
      const {Api} = await import("teleproto");
      const raw = invocation.message.raw as ApiTypes.Message | undefined;
      const replied = reply.raw as ApiTypes.Message | undefined;
      if (!replied) throw new SourceMissingError();
      const sourcePeer=raw?.peerId??returnBigInt(invocation.message.chatId);
      const values: any[] = [];
      const limit=Math.min(count*3,MAX_SEARCH);
      for (let id = replied.id; values.length < count && id < replied.id + limit; id++) {
        signal.throwIfAborted();
        try{
          const result = await client.getMessages(sourcePeer, {ids: [id]});
          const message = Array.isArray(result) ? result[0] : result;
          if (message?.id) values.push(message.id);
        }catch(error){signal.throwIfAborted();context.log.info("bs_source_message_skipped");}
      }
      if (!values.length) throw new NoMessagesError();
      let targetEntity: any;
      let targetConfig: Target | undefined;
      let messages: any[] = [];
      // 按顺序查找第一个有权限的目标
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
            catch(error){if(restrictedError(error))throw new ForwardRestrictedError();
              const delay=floodWait(error);if(delay===undefined)throw error;
              if(delay>MAX_FLOOD_WAIT_MS||attempt===1)throw new FloodRetryError();await wait(delay,signal);}
          }
          signal.throwIfAborted();
          messages = forwarded(result);
          targetEntity = entity;
          targetConfig = target;
          break; // 成功后停止
        } catch(error) {signal.throwIfAborted();if(error instanceof ForwardRestrictedError||error instanceof FloodRetryError)throw error;
          context.log.info("bs_target_skipped",{target:target.target});}
      }
      if (!messages.length||!targetEntity||!targetConfig) {
        await context.telegram.edit(invocation.message, "没有找到有发送权限的频道", {parseMode: "html"}); return; }
      signal.throwIfAborted();
      // 目标改名后回写
      if(targetEntity?.id!==undefined&&targetEntity?.id!==null){
        const chatId=String(targetEntity.id);const display=entityName(targetEntity,targetConfig.display||targetConfig.target);
        if(targetConfig.chatId!==chatId||targetConfig.display!==display){
          await store(context).update(source=>{const value=normalize(source);
            const found=value.targets.find(t=>t.id===targetConfig!.id);
            if(found){found.chatId=chatId;found.display=display;found.updatedAt=String(Date.now());}
            return value;});
        }
      }
      signal.throwIfAborted();
      let sourceEntity:any;
      try{sourceEntity=await client.getEntity(sourcePeer);signal.throwIfAborted();}
      catch{signal.throwIfAborted();context.log.error("bs_source_entity_failed");}
      // 在目标频道回复第一条转发的消息
      const first=messages[0];if(first?.id){
        const sourceName=escape(entityName(sourceEntity,"来源对话"));
        const sourceUrl=entityLink(sourceEntity);
        const source=sourceUrl?`<a href="${escape(sourceUrl)}">${sourceName}</a>`:sourceName;
        const sentIds=messages.map(message=>message?.id).filter((id):id is number=>typeof id==="number");
        const sent=linkTags(targetEntity,sentIds);
        try{await client.sendMessage(targetEntity,{message:`来源：${source}<br>消息：${sent}`,parseMode:"html",linkPreview:false,replyTo:first.id,
          ...(targetConfig.topicId&&/^\d+$/.test(targetConfig.topicId)?{topMsgId:Number(targetConfig.topicId)}:{})});}
        catch{signal.throwIfAborted();context.log.error("bs_target_feedback_failed");}
      }
      // 回执消息
      const forwardedCount = messages.filter(message => typeof message?.id === "number").length;
      const targetName = escape(entityName(targetEntity,targetConfig.display || targetConfig.target));
      const targetUrl = entityLink(targetEntity);
      const targetHtml = targetUrl ? `<a href="${escape(targetUrl)}">${targetName}</a>` : targetName;
      await context.telegram.edit(invocation.message, `亲爱的被观察者 您的 ${forwardedCount} 条消息已被保送到频道 ${targetHtml}`, {parseMode: "html", linkPreview: false});
    });
  } catch(error) {
    if (context.signal.aborted) return;
    context.log.error("bs_forward_failed");
    await context.telegram.edit(invocation.message, error instanceof ForwardRestrictedError ? "该消息不允许被转发"
      : error instanceof FloodRetryError ? "操作频繁，请稍后重试"
      : error instanceof SourceMissingError ? "无法获取被回复的消息"
      : error instanceof NoMessagesError ? "未找到可转发的消息\n请确认消息未被删除"
      : "保送失败，请检查目标权限或稍后重试");
  }
}

export default function createBs() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "bs", description: "将回复消息保送至已配置目标",
    async setup(context) { await store(context).update(normalize); },
    commands: {bs: {description: "回复消息后转发到配置的频道", async handle(invocation: any, context: PluginContext) {
      const command = (invocation.args[0] ?? "").toLowerCase();
      if (!command || /^\d+$/.test(command)) return forward(invocation, context, command ? Number(command) : 1);
      await context.telegram.edit(invocation.message, `<b>保送插件</b>\n<code>${invocation.prefix}bs [数量]</code> 回复消息后转发`, {parseMode: "html"});
    }}},
  });
}
