import {setTimeout as sleep} from "node:timers/promises";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, type CommandInvocation, type SubcommandDefinition, definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";

const escape=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]!);
const inGroup=(m:MessageEnvelope)=>!(m.raw as any)?.isPrivate&&(m.chatId.startsWith("-")||(m.raw as any)?.isGroup||(m.raw as any)?.isChannel);
const display=(u:any,id:string)=>[u?.firstName,u?.lastName,u?.username&&`@${u.username}`].filter(Boolean).map(escape).concat(`<a href="tg://user?id=${escape(id)}">${escape(id)}</a>`).join(" ");

type Prepared = {Api: any; client: any; signal: AbortSignal; chat: any; channel: any; reply: MessageEnvelope | undefined; resolve: () => Promise<any>};
async function withChat(invocation: CommandInvocation, ctx: PluginContext, args: readonly string[], operation: (prepared: Prepared) => Promise<void>) {
  const message = invocation.message;
  await ctx.telegram.withClient(async (client: any, signal) => {
    const {Api}=await import("teleproto"); signal.throwIfAborted();
    const raw:any=message.raw, chat=await client.getEntity(raw?.peerId??message.chatId), channel=await client.getInputEntity(chat);
    const reply=message.replyToId?await ctx.telegram.getReply(message):undefined;
    const targetToken=reply?.senderId??args[0];
    const resolve=async()=>{if(!targetToken)return undefined;try{const entity=await client.getEntity(/^-?\d+$/.test(targetToken)?BigInt(targetToken):targetToken);if(entity?.className!=="User")return undefined;return{entity,input:await client.getInputEntity(entity),id:String(entity.id)};}catch{
      if(!/^-?\d+$/.test(targetToken)||chat.className!=="Channel")return undefined;let offset=0;for(let page=0;page<5;page++){signal.throwIfAborted();const r:any=await client.invoke(new Api.channels.GetParticipants({channel,filter:new Api.ChannelParticipantsRecent(),offset,limit:200,hash:0 as any}));const u=r.users?.find((x:any)=>String(x.id)===targetToken);if(u)return{entity:u,input:await client.getInputEntity(u),id:String(u.id)};if(!r.users?.length)break;offset+=r.users.length;}return undefined;}};

    await operation({Api, client, signal, chat, channel, reply, resolve});
  });
}
const administrator = (adding: boolean): SubcommandDefinition => ({
  description: adding ? "设置管理员和头衔" : "移除管理员身份", aliases: adding ? ["set"] : ["remove", "del"],
  args: adding ? "[用户] [头衔]" : "[用户]",
  arguments: [{name: "用户", description: "用户名或数字 ID；回复消息时以被回复发送者为目标"}, ...(adding ? [{name: "头衔", description: "可包含空格，最多 16 个字符；省略时清空"}] : [])],
  examples: [{args: adding ? "add @username 值班管理员" : "rm @username"}, ...(adding ? [{args: "add 值班管理员", description: "回复某用户消息"}] : [])],
  async handle(invocation, ctx) {
    const message = invocation.message, args = invocation.args;
    await withChat(invocation, ctx, args, async ({Api, client, signal, chat, channel, reply, resolve}) => {
    let allowed=chat.className==="Chat"?(!!chat.creator||!!chat.adminRights):false;if(chat.className==="Channel")try{const me=await client.getMe(),self=(await client.invoke(new Api.channels.GetParticipant({channel,participant:me.id}))).participant;allowed=self?.className==="ChannelParticipantCreator"||(self?.className==="ChannelParticipantAdmin"&&!!self.adminRights?.addAdmins);}catch{allowed=false;}if(!allowed){await ctx.telegram.edit(message,"权限不足：需要添加管理员权限");return;}
    const target=await resolve();if(!target){await ctx.telegram.edit(message,"请回复一条消息或提供 用户ID/用户名");return;}
    const title=(reply?args:args.slice(1)).join(" ").slice(0,16);
    try{if(chat.className==="Channel")await client.invoke(new Api.channels.EditAdmin({channel,userId:target.input,adminRights:new Api.ChatAdminRights(adding?{banUsers:true}:{}),rank:adding?title:""}));else await client.invoke(new Api.messages.EditChatAdmin({chatId:chat.id,userId:target.input,isAdmin:adding}));
      let appliedRank=title,selfIsCreator=false;
      if(adding){
        if(chat.className==="Channel")await sleep(1200,undefined,{signal});
        try{
          const me=await client.getMe();
          selfIsCreator=(await client.invoke(new Api.channels.GetParticipant({channel,participant:me.id}))).participant?.className==="ChannelParticipantCreator";
          const refreshed=(await client.invoke(new Api.channels.GetParticipant({channel,participant:target.input}))).participant;
          if(["ChannelParticipantAdmin","ChannelParticipantCreator"].includes(refreshed?.className))appliedRank=refreshed.rank||"";
        }catch{signal.throwIfAborted();}
      }
      const rankText=adding&&title?(appliedRank===title?`，头衔：<code>${escape(title)}</code>`:`，但头衔未更新。${selfIsCreator?"可能原因：非超级群或系统暂未同步。":"可能原因：仅群主可设置头衔；或非超级群；或系统暂未同步。"}`):"";
      await ctx.telegram.edit(message,`${adding?"已设置":"已移除"}管理员: ${display(target.entity,target.id)}${rankText}`,{parseMode:"html"});
    }catch(error){const detail=String((error as any)?.message??error);const extra=detail.includes("USER_ID_INVALID")?"\n可能原因：目标不是当前对话中的用户、匿名管理员、或数字 ID 无法解析。":"";await ctx.telegram.edit(message,`${adding?"设置":"移除"}管理员失败：<code>${escape(detail)}</code>${extra}`,{parseMode:"html"});}
    });
  },
});
const command: CommandDefinition = {
  description: "管理管理员", helpArgs: ["help", "h"], helpOnEmpty: true, ignoreEdited: true,
  subcommandsCaseSensitive: false,
  async authorize(invocation, ctx) {
    if (inGroup(invocation.message)) return true;
    await ctx.telegram.edit(invocation.message, `请在群组/频道对话中使用 <code>${escape(invocation.prefix)}manage_admin</code> 命令`, {parseMode: "html"});
    return false;
  },
  subcommands: {
    add: administrator(true), rm: administrator(false),
    list: {description: "查看当前超级群或频道管理员，最多返回 200 人", aliases: ["ls"], args: "", examples: [{args: "list"}],
      async handle(invocation, ctx) {
        const message = invocation.message;
        await withChat(invocation, ctx, invocation.args, async ({Api, client, chat, channel}) => {
          if(chat.className!=="Channel"){await ctx.telegram.edit(message,"仅支持超级群/频道列出管理员");return;}const r:any=await client.invoke(new Api.channels.GetParticipants({channel,filter:new Api.ChannelParticipantsAdmins(),offset:0,limit:200,hash:0 as any}));const users=new Map((r.users||[]).map((u:any)=>[String(u.id),u]));const lines=(r.participants||[]).map((p:any)=>{const id=String(p.userId),u=users.get(id);return `- ${display(u,id)}${p.rank?` | 头衔: <code>${escape(p.rank)}</code>`:""}`;});await ctx.telegram.edit(message,lines.length?`当前管理员列表：\n${lines.join("\n")}`:"当前对话没有管理员或无法获取",{parseMode:"html"});
        });
      }},
  },
  help: [
    {heading: "权限与头衔：", body: "操作在当前群组或频道执行。超级群和频道需要群主身份或添加管理员权限。add 将目标权限设置为仅封禁用户，即使目标已是管理员也会应用该权限；头衔省略时清空。基本群使用 Telegram 管理员开关，权限和头衔行为受群类型限制；列表仅支持超级群和频道。"},
    {heading: "常见提示：", body: "权限不足时检查账号是否能添加管理员；目标无效时优先回复用户消息，目标需为用户；头衔未更新时根据回执检查群类型、群主权限及服务端同步状态。"},
  ],
  async handle(invocation, ctx) {
    const sub = invocation.args[0]?.toLowerCase();
    const show = () => ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
    if (!sub || sub === "help" || sub === "h") { await show(); return; }
    await withChat(invocation, ctx, invocation.args.slice(1), async () => { await show(); });
  },
};
const help = (prefix: string) => renderCommandHelp("manage_admin", command, {prefix, title: "👮 群组管理员管理"});
export default function createManageAdmin() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "manage_admin", description: "添加、移除和列出群组管理员", renderHelp: help, commands: {manage_admin: command}});
}
