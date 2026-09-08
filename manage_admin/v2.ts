import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";

const escape=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]!);
const help=(p:string)=>`管理管理员\n\n<code>${escape(p)}manage_admin add [用户] [头衔]</code>\n<code>${escape(p)}manage_admin rm/remove [用户]</code>\n<code>${escape(p)}manage_admin ls/list</code>\n回复消息时可省略用户；新增管理员默认仅授予封禁权限。`;
const inGroup=(m:MessageEnvelope)=>!(m.raw as any)?.isPrivate&&(m.chatId.startsWith("-")||(m.raw as any)?.isGroup||(m.raw as any)?.isChannel);
const display=(u:any,id:string)=>[u?.firstName,u?.lastName,u?.username&&`@${u.username}`].filter(Boolean).map(escape).concat(`<a href="tg://user?id=${escape(id)}">${escape(id)}</a>`).join(" ");

async function run(message:MessageEnvelope,args:readonly string[],prefix:string,ctx:PluginContext){
  if(!inGroup(message)){await ctx.telegram.edit(message,`请在群组/频道对话中使用 <code>${escape(prefix)}manage_admin</code> 命令`,{parseMode:"html"});return;}
  const sub=(args[0]||"").toLowerCase(); if(!sub||["help","h"].includes(sub)){await ctx.telegram.edit(message,help(prefix),{parseMode:"html"});return;}
  await ctx.telegram.withClient(async(client:any,signal)=>{
    const {Api}=await import("teleproto"); signal.throwIfAborted();
    const raw:any=message.raw, chat=await client.getEntity(raw?.peerId??message.chatId), channel=await client.getInputEntity(chat);
    const reply=message.replyToId?await ctx.telegram.getReply(message):undefined;
    const targetToken=reply?.senderId??args[1];
    const resolve=async()=>{if(!targetToken)return undefined;try{const entity=await client.getEntity(/^-?\d+$/.test(targetToken)?BigInt(targetToken):targetToken);if(entity?.className!=="User")return undefined;return{entity,input:await client.getInputEntity(entity),id:String(entity.id)};}catch{
      if(!/^-?\d+$/.test(targetToken)||chat.className!=="Channel")return undefined;let offset=0;for(let page=0;page<5;page++){signal.throwIfAborted();const r:any=await client.invoke(new Api.channels.GetParticipants({channel,filter:new Api.ChannelParticipantsRecent(),offset,limit:200,hash:0 as any}));const u=r.users?.find((x:any)=>String(x.id)===targetToken);if(u)return{entity:u,input:await client.getInputEntity(u),id:String(u.id)};if(!r.users?.length)break;offset+=r.users.length;}return undefined;}};
    if(["ls","list"].includes(sub)){if(chat.className!=="Channel"){await ctx.telegram.edit(message,"仅支持超级群/频道列出管理员");return;}const r:any=await client.invoke(new Api.channels.GetParticipants({channel,filter:new Api.ChannelParticipantsAdmins(),offset:0,limit:200,hash:0 as any}));const users=new Map((r.users||[]).map((u:any)=>[String(u.id),u]));const lines=(r.participants||[]).map((p:any)=>{const id=String(p.userId),u=users.get(id);return `- ${display(u,id)}${p.rank?` | 头衔: <code>${escape(p.rank)}</code>`:""}`;});await ctx.telegram.edit(message,lines.length?`当前管理员列表：\n${lines.join("\n")}`:"当前对话没有管理员或无法获取",{parseMode:"html"});return;}
    if(!["add","set","rm","remove","del"].includes(sub)){await ctx.telegram.edit(message,help(prefix),{parseMode:"html"});return;}
    let allowed=chat.className==="Chat"?(!!chat.creator||!!chat.adminRights):false;if(chat.className==="Channel")try{const me=await client.getMe(),self=(await client.invoke(new Api.channels.GetParticipant({channel,participant:me.id}))).participant;allowed=self?.className==="ChannelParticipantCreator"||(self?.className==="ChannelParticipantAdmin"&&!!self.adminRights?.addAdmins);}catch{allowed=false;}if(!allowed){await ctx.telegram.edit(message,"权限不足：需要添加管理员权限");return;}
    const target=await resolve();if(!target){await ctx.telegram.edit(message,"请回复一条消息或提供 用户ID/用户名");return;}
    const adding=["add","set"].includes(sub);const title=(reply?args.slice(1):args.slice(2)).join(" ").slice(0,16);
    try{if(chat.className==="Channel")await client.invoke(new Api.channels.EditAdmin({channel,userId:target.input,adminRights:new Api.ChatAdminRights(adding?{banUsers:true}:{}),rank:adding?title:""}));else await client.invoke(new Api.messages.EditChatAdmin({chatId:chat.id,userId:target.input,isAdmin:adding}));
      await ctx.telegram.edit(message,`${adding?"已设置":"已移除"}管理员: ${display(target.entity,target.id)}${adding&&title?`，头衔：<code>${escape(title)}</code>`:""}`,{parseMode:"html"});
    }catch(error){const detail=String((error as any)?.message??error);const extra=detail.includes("USER_ID_INVALID")?"\n可能原因：目标不是当前对话中的用户、匿名管理员、或数字 ID 无法解析。":"";await ctx.telegram.edit(message,`${adding?"设置":"移除"}管理员失败：<code>${escape(detail)}</code>${extra}`,{parseMode:"html"});}
  });
}

export default function createManageAdmin(){return definePlugin({renderHelp: renderPluginHelp, apiVersion:1,id:"manage_admin",description:"添加、移除和列出群组管理员",commands:{manage_admin:{helpArgs: ["help","h"], helpOnEmpty: true, description:"管理管理员",ignoreEdited:true,async handle({message,args,prefix},ctx){await run(message,args,prefix,ctx);}}}});}
