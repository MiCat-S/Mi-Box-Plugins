import {setTimeout as sleep} from "node:timers/promises";
import {
  STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, ui,
  type CommandDefinition, type MessageEnvelope, type PluginContext,
} from "telebox/sdk";
import {extractLinks, hasMediaPayload, isFinalBotMessage, isProgressText} from "./v2/links";
import {returnBigInt} from "teleproto/Helpers";

const BOT = "@ParseHubot";
const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 10 * 60_000;
const HARD_WAIT_MS = 30 * 60_000;
const RESULT_IDLE_MS = 5_000;
const PROGRESS_EXTEND_MS = 2 * 60_000;
const FETCH_LIMIT = 50;

type State = {schemaVersion: 1; initialized: boolean; ignoredUpToId: number; [key: string]: unknown};
type RelayReason = "timeout" | "fetch_failed" | "send_failed" | "forward_failed";
type RelayOutcome = {lastId: number; forwarded: boolean; reason?: RelayReason};
type RelayTarget = {peer: unknown; replyTo: number; topMsgId?: number};

const defaults: State = {schemaVersion: 1, initialized: false, ignoredUpToId: 0};
const store = (context: PluginContext) => context.storage.json<State>("state.json", defaults);
const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g,
  character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;"})[character]!);

function normalizeState(value: unknown): State {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const boundary = Number(source.ignoredUpToId);
  return {...source, schemaVersion: 1, initialized: source.initialized === true,
    ignoredUpToId: Number.isSafeInteger(boundary) && boundary >= 0 ? boundary : 0};
}

function messageId(message: unknown): number {
  const id = Number((message as {id?: unknown} | undefined)?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function textPages(source:string):string[]{const budget=ui.MAX_HTML_LENGTH-ui.PAGE_LABEL_RESERVE,result:string[]=[];let page="";for(const character of source){if(page&&page.length+character.length>budget){result.push(page);page="";}page+=character;}if(page)result.push(page);return result;}

function botMessages(messages: unknown): any[] {
  return (Array.isArray(messages) ? messages : []).filter(message =>
    message && (message as {className?: unknown}).className !== "MessageService" && messageId(message) > 0);
}

function incoming(messages: unknown): any[] {
  return botMessages(messages).filter(message => !(message as {out?: unknown}).out);
}

async function latestBotMessageId(client: any, signal: AbortSignal, incomingOnly = false): Promise<number> {
  signal.throwIfAborted();
  const history = botMessages(await client.getMessages(BOT, {limit: FETCH_LIMIT}));
  signal.throwIfAborted();
  return (incomingOnly ? incoming(history) : history)
    .reduce((latest, message) => Math.max(latest, messageId(message)), 0);
}

async function advanceBoundary(context: PluginContext, value: number, initialized?: boolean): Promise<void> {
  await store(context).update(source => {
    const state = normalizeState(source);
    return {...state, initialized: initialized ?? state.initialized, ignoredUpToId: Math.max(state.ignoredUpToId, value)};
  });
}

async function ensureBotReady(client: any, signal: AbortSignal): Promise<{ready: boolean; boundary: number}> {
  signal.throwIfAborted();
  const {Api} = await import("teleproto");
  signal.throwIfAborted();
  try {
    const entity: any = await client.getEntity(BOT);
    signal.throwIfAborted();
    const id = entity?.id !== undefined && entity?.accessHash !== undefined
      ? new Api.InputUser({userId: entity.id, accessHash: entity.accessHash}) : BOT;
    await client.invoke(new Api.contacts.Unblock({id}));
    signal.throwIfAborted();
  } catch {signal.throwIfAborted();}
  try {
    const peer = await client.getInputEntity(BOT);
    signal.throwIfAborted();
    await client.invoke(new Api.account.UpdateNotifySettings({
      peer,
      settings: new Api.InputPeerNotifySettings({silent: true, muteUntil: 2_147_483_647}),
    }));
    signal.throwIfAborted();
  } catch {signal.throwIfAborted();}

  let boundary = await latestBotMessageId(client, signal, true);
  if (boundary) return {ready: true, boundary};
  const sent = await client.sendMessage(BOT, {message: "/start"});
  signal.throwIfAborted();
  boundary = Math.max(boundary, messageId(sent));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(500, undefined, {signal});
    const welcome = await latestBotMessageId(client, signal, true);
    if (welcome) return {ready: true, boundary: Math.max(boundary, welcome)};
  }
  return {ready: false, boundary};
}

function reasonText(reason?: RelayReason): string {
  switch (reason) {
    case "send_failed": return "向解析机器人发送链接失败";
    case "fetch_failed": return "读取解析机器人消息失败";
    case "forward_failed": return "转发解析结果失败";
    default: return "等待解析结果超时";
  }
}

async function relay(
  client: any, target: RelayTarget, link: string, baseline: number, signal: AbortSignal,
): Promise<RelayOutcome> {
  let requestBoundary = baseline;
  try {requestBoundary = Math.max(requestBoundary, messageId(await client.sendMessage(BOT, {message: link})));signal.throwIfAborted();}
  catch {signal.throwIfAborted(); return {lastId: baseline, forwarded: false, reason: "send_failed"};}

  const started = Date.now();
  const hardDeadline = started + HARD_WAIT_MS;
  let deadline = started + MAX_WAIT_MS;
  let lastId = requestBoundary;
  let lastFinalActivity = 0;
  let lastProgressActivity = started;
  const progress = new Map<number, string>();
  const finals = new Map<number, any>();

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS, undefined, {signal});
    let messages: any[];
    try {messages = incoming(await client.getMessages(BOT, {limit: FETCH_LIMIT}));}
    catch {signal.throwIfAborted(); return {lastId, forwarded: false, reason: "fetch_failed"};}
    signal.throwIfAborted();
    messages.sort((left, right) => messageId(left) - messageId(right));
    for (const item of messages) {
      const id = messageId(item);
      if (id <= requestBoundary) continue;
      lastId = Math.max(lastId, id);
      const text = String(item.message ?? "").trim();
      if (isProgressText(text) && !hasMediaPayload(item)) {
        const newestFinal = finals.size ? Math.max(...finals.keys()) : 0;
        if (newestFinal > id) {progress.delete(id); continue;}
        const fingerprint = `${text}\u0000${String(item.editDate ?? item.edit_date ?? "")}\u0000${String(item.media?.className ?? "")}`;
        if (progress.get(id) !== fingerprint) {
          progress.set(id, fingerprint);
          lastProgressActivity = Date.now();
          if (!finals.size) deadline = Math.min(hardDeadline, Math.max(deadline, Date.now() + PROGRESS_EXTEND_MS));
        }
        continue;
      }
      if (!isFinalBotMessage(item)) continue;
      for (const progressId of progress.keys()) if (progressId <= id) progress.delete(progressId);
      if (!finals.has(id)) {
        finals.set(id, item);
        lastFinalActivity = Date.now();
      }
    }
    const finalIdle = finals.size > 0 && Date.now() - lastFinalActivity >= RESULT_IDLE_MS;
    if (finalIdle && (!progress.size || Date.now() - lastProgressActivity >= RESULT_IDLE_MS * 3)) break;
  }

  if (!finals.size) return {lastId, forwarded: false, reason: "timeout"};
  const messages = [...finals.values()].sort((left, right) => messageId(left) - messageId(right));
  let complete = true;
  for (let offset = 0; offset < messages.length; offset += 100) {
    const chunk = messages.slice(offset, offset + 100);
    try {
      await client.forwardMessages(target.peer, {fromPeer: BOT, messages: chunk.map(messageId), dropAuthor: true,
        replyTo: target.replyTo, ...(target.topMsgId === undefined ? {} : {topMsgId: target.topMsgId})});
      signal.throwIfAborted();
    } catch {
      signal.throwIfAborted();
      if(chunk.some(hasMediaPayload))complete=false;
      const text=chunk.map(message=>String(message.message??"").trim()).filter(Boolean).join("\n\n");
      if(!text){complete=false;continue;}
      try{
        const pages=textPages(`ParseHub 返回内容：\n\n${text}`);
        for(const [index,page] of pages.entries()){
          await client.sendMessage(target.peer,{message:page+ui.pageLabel(index,pages.length),parseMode:false,
            replyTo:target.replyTo,...(target.topMsgId===undefined?{}:{topMsgId:target.topMsgId})});
          signal.throwIfAborted();
        }
      }catch{signal.throwIfAborted();complete=false;}
      }
  }
  return {lastId,forwarded:complete,...(complete?{}:{reason:"forward_failed" as const})};
}

export default function createParsehub() {
  let ready = false;
  let tail = Promise.resolve();

  const serialized = async <T>(context: PluginContext, operation: () => Promise<T>): Promise<T> => {
    const signal=context.signal,previous=tail;
    let started=false;
    const queued=previous.catch(()=>undefined).then(()=>{started=true;signal.throwIfAborted();return operation();});
    tail=queued.then(()=>undefined,()=>undefined);
    return new Promise<T>((resolve,reject)=>{let settled=false;const finish=(callback:()=>void)=>{if(settled)return;settled=true;signal.removeEventListener("abort",abort);callback();};const abort=()=>{if(!started)finish(()=>reject(signal.reason));};signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();queued.then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)));});
  };

  const command: CommandDefinition = {
    description: "通过 ParseHubot 解析社交媒体链接",
    helpArgs: ["help", "h"],
    args: "[链接...]",
    arguments: [{name: "链接", description: "命令或回复消息中的 HTTP/HTTPS 链接；单次处理第一条"}],
    examples: [{args: "https://twitter.com/user/status/123"}, {args: "", description: "回复含链接的消息"}],
    help: [
      {heading: "说明：", body: "链接会发送给第三方 Telegram 机器人 @ParseHubot；支持抖音、哔哩哔哩、YouTube、TikTok、小红书、Twitter、贴吧、Facebook、微博和 Instagram 等平台。存在多条链接时处理第一条。"},
      {heading: "会话：", body: "所有聊天共享一个机器人会话队列，避免并发解析结果串线；每条链接最长等待 10 分钟，进度仍活跃时最多延长到 30 分钟。"},
    ],
    async handle(invocation, context) {
      let links = extractLinks(invocation.args.join(" "));
      if (invocation.message.replyToId !== undefined) {
        try {
          const reply = await context.telegram.getReply(invocation.message);
          links = [...new Set([...links, ...extractLinks(reply?.text ?? "")])];
        } catch {context.signal.throwIfAborted();}
      }
      if (!links.length) {
        await context.telegram.edit(invocation.message, renderCommandHelp("parsehub", command, {prefix: invocation.prefix, title: "🔗 ParseHub 解析"}), {parseMode: "html"});
        return;
      }
      links=links.slice(0,1);
      await context.telegram.edit(invocation.message, `已提交 ${links.length} 条链接，等待 ParseHubot 解析…`);
      let completed:number;
      try {
        completed = await serialized(context, () => context.telegram.withClient(async (client, signal) => {
          let state = normalizeState(await store(context).read());
          if (!ready) {
            const readiness = await ensureBotReady(client, signal);
            await advanceBoundary(context, readiness.boundary, readiness.ready);
            if (!readiness.ready) throw new Error("ParseHubot 启动超时");
            ready = true;
            state = normalizeState(await store(context).read());
          }
          let boundary = Math.max(state.ignoredUpToId, await latestBotMessageId(client, signal));
          await advanceBoundary(context, boundary);
          const raw = invocation.message.raw as {peerId?: unknown} | undefined;
          const peer = raw?.peerId ?? await client.getInputEntity(returnBigInt(invocation.message.chatId));
          signal.throwIfAborted();
          const target: RelayTarget = {peer, replyTo: invocation.message.id,
            ...(invocation.message.topicId === undefined ? {} : {topMsgId: invocation.message.topicId})};
          let success = 0;
          for (const link of links) {
            signal.throwIfAborted();
            const outcome = await relay(client, target, link, boundary, signal);
            boundary = Math.max(boundary, outcome.lastId);
            await advanceBoundary(context, boundary);
            if (outcome.forwarded) success += 1;
            else await context.telegram.reply(invocation.message,
              `⚠️ <b>解析未完成</b>\n${escape(link)}\n${escape(reasonText(outcome.reason))}`, {parseMode: "html", linkPreview: false});
            if (link !== links.at(-1)) await sleep(600, undefined, {signal});
          }
          return success;
        }));
      } catch {
        context.signal.throwIfAborted();
        context.log.error("parsehub_failed");
        await context.telegram.edit(invocation.message, "ParseHub 解析失败，请稍后重试或直接联系 @ParseHubot");
        return;
      }
      try{await context.telegram.edit(invocation.message,`ParseHub 处理完成：${completed}/${links.length} 条链接已转发`);}catch{context.signal.throwIfAborted();context.log.error("parsehub_receipt_failed",{kind:"internal"});}
      context.signal.throwIfAborted();
      const raw=invocation.message.raw as {delete?:(options:{revoke:boolean})=>Promise<unknown>}|undefined;
      if(typeof raw?.delete==="function")try{await raw.delete({revoke:true});}catch{context.signal.throwIfAborted();context.log.error("parsehub_cleanup_failed",{kind:"internal"});}
    },
  };
  const help = (prefix: string) => renderCommandHelp("parsehub", command, {prefix, title: "🔗 ParseHub 解析"});

  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "parsehub",
    description: "通过 ParseHubot 解析社交媒体链接",
    renderHelp: help,
    commands: {parsehub: command},
    settings: context => ({
      id: "parsehub", title: "ParseHub 解析", description: "初始化状态与机器人消息水位", category: "插件配置", icon: "🔗",
      getSchema: () => [
        {key: "initialized", label: "已初始化", type: "boolean"},
        {key: "ignoredUpToId", label: "忽略消息 ID", type: "number", min: 0},
        {key: "resetState", label: "重置状态", type: "boolean", default: false},
      ],
      getValues: async () => {
        const state = normalizeState(await store(context).read());
        return {initialized: state.initialized, ignoredUpToId: state.ignoredUpToId, resetState: false};
      },
      setValues: async patch => {
        if (patch.resetState === true) {
          ready = false;
          await store(context).update(source => ({...source, schemaVersion: 1, initialized: false, ignoredUpToId: 0}));
          return;
        }
        await store(context).update(source => {
          const state = normalizeState(source);
          const boundary = patch.ignoredUpToId === undefined ? state.ignoredUpToId : Number(patch.ignoredUpToId);
          if (!Number.isSafeInteger(boundary) || boundary < 0) throw new Error("invalid message boundary");
          return {...state,
            initialized: patch.initialized === undefined ? state.initialized : patch.initialized === true,
            ignoredUpToId: boundary};
        });
      },
    }),
    async setup(context) {
      await store(context).update(normalizeState);
    },
    cleanup() {ready = false; tail = Promise.resolve();},
  });
}

export {extractLinks, hasMediaPayload, isFinalBotMessage, isProgressText};
