import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type CommandInvocation, type MessageEnvelope, type PluginContext, type SubcommandDefinition} from "telebox/sdk";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {returnBigInt} from "teleproto/Helpers";

type Action="delete"|"ban";
type MonitoredChat={id:string;name:string;username?:string};
type State={schemaVersion:1;enabled:boolean;monitoredChats:MonitoredChat[];bannedMD5s:Record<string,Action>;bannedStickerIds:Record<string,Action>;defaultAction:Action;importedLegacy:boolean;[key:string]:unknown};
const defaults:State={schemaVersion:1,enabled:true,monitoredChats:[],bannedMD5s:{},bannedStickerIds:{},defaultAction:"delete",importedLegacy:false};
const MAX_FILE_SIZE=30*1024*1024;
const store=(ctx:PluginContext)=>ctx.storage.json<State>("config.json",defaults);
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[c]!);
const error=(e:unknown)=>e instanceof Error?e.message:String(e);
const action=(value:unknown):Action=>value==="ban"?"ban":"delete";
function normalize(value:any):State{return{...value,schemaVersion:1,enabled:value?.enabled!==false,monitoredChats:Array.isArray(value?.monitoredChats)?value.monitoredChats.map((v:any)=>typeof v==="object"&&v?{id:String(v.id),name:String(v.name??v.id),...(v.username?{username:String(v.username)}:{})}:{id:String(v),name:String(v)}):[],bannedMD5s:Object.fromEntries(Object.entries(value?.bannedMD5s??{}).map(([k,v])=>[k,action(v)])),bannedStickerIds:Object.fromEntries(Object.entries(value?.bannedStickerIds??{}).map(([k,v])=>[k,action(v)])),defaultAction:action(value?.defaultAction),importedLegacy:true};}
async function migrate(ctx:PluginContext){const current=await store(ctx).read();if(current.importedLegacy&&current.schemaVersion===1)return;let source:any=current;try{const file=ctx.files?.dataPath("image_monitor_config.json");if(file)source={...JSON.parse(await readFile(file,"utf8")),...current};}catch{/* Fresh installs have no legacy JSON document. */}await store(ctx).update(()=>normalize(source));}

function document(raw:any){const media=raw?.media;if(media?.className!=="MessageMediaDocument"||media.document?.className!=="Document")return;return media.document;}
function isSticker(doc:any){return Array.isArray(doc?.attributes)&&doc.attributes.some((a:any)=>a?.className==="DocumentAttributeSticker");}
function mediaSize(raw:any){const doc=document(raw);if(doc)return Number(doc.size??0);const photo=raw?.media?.photo;if(photo?.className!=="Photo")return 0;return Math.max(0,...(photo.sizes??[]).flatMap((s:any)=>s?.sizes?.length?s.sizes:[s?.size??0]).map(Number));}
async function digest(ctx:PluginContext,message:MessageEnvelope){const raw=message.raw as any;if(!raw?.media)throw new Error("该消息没有媒体");const size=mediaSize(raw);if(size>MAX_FILE_SIZE)throw new Error("文件超过 30 MiB 限制");return ctx.telegram.withClient(async(client,signal)=>{const hash=createHash("md5");let received=0;for await(const chunk of client.iterDownload(raw.media,{})){signal.throwIfAborted();received+=chunk.length;if(received>MAX_FILE_SIZE)throw new Error("文件超过 30 MiB 限制");hash.update(chunk);}if(!received)throw new Error("下载媒体失败");return hash.digest("hex");});}
async function peerInfo(ctx:PluginContext,message:MessageEnvelope,target?:string){if(!target)return{id:message.chatId,name:message.chatId};return ctx.telegram.withClient(async client=>{const key:any=/^-?\d+$/.test(target)?returnBigInt(target):target;const entity:any=await client.getEntity(key);const id=entity?.className==="Channel"?`-100${entity.id}`:entity?.className==="Chat"?`-${entity.id}`:String(entity?.id??target);return{id,name:entity?.username?`@${entity.username}`:String(entity?.title??entity?.firstName??id),...(entity?.username?{username:String(entity.username)}:{})};});}
async function enforce(ctx:PluginContext,message:MessageEnvelope,act:Action){await ctx.telegram.withClient(async client=>{const raw=message.raw as any;if(act==="ban"){if(!message.senderId)throw new Error("无法确定发送者");const {Api}=await import("teleproto");const channel=await client.getInputEntity(raw?.peerId??returnBigInt(message.chatId));const participant=await client.getInputEntity(returnBigInt(message.senderId));await client.invoke(new Api.channels.EditBanned({channel,participant,bannedRights:new Api.ChatBannedRights({viewMessages:true,untilDate:0})}));}await client.deleteMessages(raw?.peerId??returnBigInt(message.chatId),[message.id],{revoke:true});});}

const guard = (operation: (invocation: CommandInvocation, ctx: PluginContext, state: State) => Promise<void>): CommandDefinition["handle"] => async (invocation, ctx) => {
  try { await operation(invocation, ctx, await store(ctx).read()); }
  catch (e) { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, `操作失败：<code>${esc(error(e))}</code>`, {parseMode: "html"}); }
};
const showHelp = async (invocation: CommandInvocation, ctx: PluginContext) => {
  await ctx.telegram.edit(invocation.message, renderCommandHelp("im", imCommand, {prefix: invocation.prefix, title: "🖼️ 图片监控"}), {parseMode: "html"});
};
const capture = async (invocation: CommandInvocation, ctx: PluginContext, state: State, selected?: Action) => {
  const {message} = invocation;
  if (!message.replyToId) { await showHelp(invocation, ctx); return; }
  const reply = await ctx.telegram.getReply(message);
  if (!reply) throw new Error("未找到被回复的消息");
  const doc = document(reply.raw), act = selected ?? state.defaultAction;
  if (doc && isSticker(doc)) {
    const id = String(doc.id);
    await store(ctx).update(v => ({...v, bannedStickerIds: {...v.bannedStickerIds, [id]: act}}));
    await ctx.telegram.edit(message, `已添加贴纸 ID：<code>${esc(id)}</code>，操作：<code>${act}</code>`, {parseMode: "html"});
    return;
  }
  const md5 = await digest(ctx, reply);
  await store(ctx).update(v => ({...v, bannedMD5s: {...v.bannedMD5s, [md5]: act}}));
  await ctx.telegram.edit(message, `已添加媒体 MD5：<code>${md5}</code>，操作：<code>${act}</code>`, {parseMode: "html"});
};
const monitorToggle = (enabled: boolean): SubcommandDefinition => ({
  description: enabled ? "启用图片监控" : "禁用图片监控", args: "", examples: [{args: enabled ? "on" : "off"}],
  handle: guard(async (invocation, ctx) => {
    await store(ctx).update(v => ({...v, enabled}));
    await ctx.telegram.edit(invocation.message, enabled ? "图片监控已启用。" : "图片监控已禁用。");
  }),
});
const monitorChat = (add: boolean): SubcommandDefinition => ({
  description: add ? "添加监控聊天" : "移除监控聊天", args: "[聊天ID|@用户名]",
  arguments: [{name: "聊天", description: "省略时使用当前对话"}], examples: [{args: add ? "addchat @group" : "delchat @group"}],
  handle: guard(async (invocation, ctx) => {
    const peer = await peerInfo(ctx, invocation.message, invocation.args[0]);
    await store(ctx).update(v => ({...v, monitoredChats: add ? (v.monitoredChats.some(x => x.id === peer.id) ? v.monitoredChats : [...v.monitoredChats, peer]) : v.monitoredChats.filter(x => x.id !== peer.id)}));
    await ctx.telegram.edit(invocation.message, `${add ? "已添加" : "已移除"}监控群组：<code>${esc(peer.name)}</code>`, {parseMode: "html"});
  }),
});
const captureCommand = (selected: Action): SubcommandDefinition => ({
  description: selected === "ban" ? "将回复的媒体加入封禁黑名单" : "将回复的媒体加入删除黑名单", args: "",
  examples: [{args: selected, description: "回复图片、媒体或贴纸"}],
  handle: guard((invocation, ctx, state) => capture(invocation, ctx, state, selected)),
});
const imCommand: CommandDefinition = {
  description: "配置图片监控", ignoreEdited: true, args: "",
  examples: [{args: "", description: "回复媒体时按默认操作加入黑名单；无回复时查看帮助"}],
  subcommandsCaseSensitive: false,
  subcommands: {
    on: monitorToggle(true), off: monitorToggle(false), addchat: monitorChat(true), delchat: monitorChat(false),
    delete: captureCommand("delete"), ban: captureCommand("ban"),
    addmd5: {description: "添加 MD5 黑名单", args: "MD5 delete|ban", examples: [{args: "addmd5 0123456789abcdef0123456789abcdef ban"}],
      handle: guard(async (invocation, ctx) => {
        const md5 = (invocation.args[0] ?? "").toLowerCase(), act = invocation.args[1];
        if (!/^[a-f0-9]{32}$/.test(md5) || !(["delete", "ban"] as unknown[]).includes(act)) throw new Error(`用法：${invocation.prefix}im addmd5 MD5 delete|ban`);
        await store(ctx).update(v => ({...v, bannedMD5s: {...v.bannedMD5s, [md5]: act as Action}}));
        await ctx.telegram.edit(invocation.message, `已添加 MD5：<code>${md5}</code>`, {parseMode: "html"});
      })},
    delmd5: {description: "删除 MD5 黑名单", args: "MD5", examples: [{args: "delmd5 0123456789abcdef0123456789abcdef"}],
      handle: guard(async (invocation, ctx) => {
        const md5 = (invocation.args[0] ?? "").toLowerCase();
        await store(ctx).update(v => { const bannedMD5s = {...v.bannedMD5s}; delete bannedMD5s[md5]; return {...v, bannedMD5s}; });
        await ctx.telegram.edit(invocation.message, `已删除 MD5：<code>${esc(md5)}</code>`, {parseMode: "html"});
      })},
    setaction: {description: "设置回复媒体时的默认操作", args: "delete|ban", examples: [{args: "setaction ban"}],
      handle: guard(async (invocation, ctx) => {
        if (invocation.args[0] !== "delete" && invocation.args[0] !== "ban") throw new Error("操作必须为 delete 或 ban");
        await store(ctx).update(v => ({...v, defaultAction: invocation.args[0] as Action}));
        await ctx.telegram.edit(invocation.message, `默认操作已设置为：<code>${invocation.args[0]}</code>`, {parseMode: "html"});
      })},
    list: {description: "查看当前配置", args: "", examples: [{args: "list"}],
      handle: guard(async (invocation, ctx, state) => {
        await ctx.telegram.edit(invocation.message, `<b>图片监控配置</b>\n状态：${state.enabled ? "启用" : "禁用"}\n默认操作：<code>${state.defaultAction}</code>\n监控群组：\n${state.monitoredChats.map(x => `<code>${esc(x.name)} (${esc(x.id)})</code>`).join("\n") || "无"}\nMD5：<code>${Object.keys(state.bannedMD5s).length}</code>\n贴纸：<code>${Object.keys(state.bannedStickerIds).length}</code>`, {parseMode: "html"});
      })},
  },
  help: [{heading: "说明：", body: "监控已添加聊天中收到的图片 MD5 和贴纸 ID。回复图片、文件媒体或贴纸使用命令可加入黑名单；省略操作时使用默认操作。delete 删除匹配消息；ban 封禁发送者后删除消息，需要相应管理权限。媒体哈希计算上限为 30 MiB。"}],
  handle: guard(async (invocation, ctx, state) => {
    if (!invocation.args.length) await capture(invocation, ctx, state);
    else await showHelp(invocation, ctx);
  }),
};
const imageMonitorPlugin=definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "im", description: "监控指定聊天中的图片哈希和贴纸 ID",
  renderHelp: prefix => renderCommandHelp("im", imCommand, {prefix, title: "🖼️ 图片监控"}),
  commands: {im: imCommand},
  listeners: [{direction: "incoming", edited: true, ignoreCommands: true, async handle(message, ctx) {
    const state = await store(ctx).read();
    if (!state.enabled || !state.monitoredChats.some(x => x.id === message.chatId)) return;
    const raw = message.raw as any, doc = document(raw);
    let act: Action | undefined;
    if (doc && isSticker(doc)) act = state.bannedStickerIds[String(doc.id)];
    else if (raw?.media && (raw.media.className === "MessageMediaPhoto" || (doc?.mimeType ?? "").startsWith("image/"))) {
      if (mediaSize(raw) > MAX_FILE_SIZE) return;
      try { act = state.bannedMD5s[await digest(ctx, message)]; }
      catch (e) { if (!ctx.signal.aborted) ctx.log.error("im:digest", {error: error(e).slice(0, 300)}); return; }
    }
    if (act) await enforce(ctx, message, act);
  }}],
  settings: ctx => ({id: "im", title: "图片监控", description: "图片监控开关与默认处置", category: "插件配置", icon: "🖼️", getSchema: () => [{key: "enabled", label: "启用监控", type: "boolean"}, {key: "defaultAction", label: "默认操作", type: "select", options: [{value: "delete", label: "删除"}, {value: "ban", label: "封禁"}]}], getValues: async () => { const v = await store(ctx).read(); return {enabled: v.enabled, defaultAction: v.defaultAction}; }, setValues: async patch => { await store(ctx).update(v => ({...v, enabled: typeof patch.enabled === "boolean" ? patch.enabled : v.enabled, defaultAction: patch.defaultAction === "ban" ? "ban" : patch.defaultAction === "delete" ? "delete" : v.defaultAction})); }}), async setup(ctx) { await migrate(ctx); }});

export default function createImageMonitor(){return imageMonitorPlugin;}
