import {randomUUID} from "node:crypto";
import {setTimeout as sleep} from "node:timers/promises";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, type CommandInvocation, definePlugin, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {returnBigInt} from "teleproto/Helpers";

type Participant={userId:string;username?:string;firstName?:string;lastName?:string;joinedAt:number};
type Winner=Participant&{prize?:string;status:"prepared"|"sent"|"claimed"|"expired";assignedAt:number;expiresAt:number;messageId?:number};
type Activity={id:string;chatId:string;title:string;keyword:string;maxParticipants:number;winnerCount:number;warehouse:string;creatorId:string;createdAt:number;status:"active"|"drawing"|"completed"|"cancelled";messageId?:number;deleteDelay:number;claimTimeout:number;requireAvatar:boolean;requireUsername:boolean;requiredChannel?:string;allowBots:boolean;participants:Participant[];winners:Winner[]};
type Prize={text:string;stock:number;order:number};
type Settings={minUsers:number;maxUsers:number;timeout:number};
type State={schemaVersion:1;activities:Record<string,Activity>;warehouses:Record<string,Prize[]>;settings:Settings;importedLegacy:boolean;[key:string]:unknown};
const defaults:State={schemaVersion:1,activities:{},warehouses:{},settings:{minUsers:2,maxUsers:1000,timeout:60},importedLegacy:false};
const store=(ctx:PluginContext)=>ctx.storage.json<State>("state.json",defaults);
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"})[c]!);
const error=(e:unknown)=>e instanceof Error?e.message:String(e);
const current=(state:State,chatId:string)=>Object.values(state.activities).filter(x=>x.chatId===chatId&&x.status==="active").sort((a,b)=>b.createdAt-a.createdAt)[0];
const latest=(state:State,chatId:string)=>Object.values(state.activities).filter(x=>x.chatId===chatId).sort((a,b)=>b.createdAt-a.createdAt)[0];
function normalizedActivity(v:any):Activity|undefined{if(v?.chatId===undefined&&v?.chat_id===undefined)return;const id=String(v.id??v.unique_id??randomUUID());return{id,chatId:String(v.chatId??v.chat_id),title:String(v.title??"抽奖"),keyword:String(v.keyword??"抽奖"),maxParticipants:Number(v.maxParticipants??v.max_participants)||100,winnerCount:Number(v.winnerCount??v.winner_count)||1,warehouse:String(v.warehouse??v.prize_warehouse??"default"),creatorId:String(v.creatorId??v.creator_id??""),createdAt:Number(v.createdAt??v.created_at)||Date.now(),status:["active","drawing","completed","cancelled"].includes(v.status)?v.status:"active",...(Number.isSafeInteger(Number(v.messageId??v.message_id))?{messageId:Number(v.messageId??v.message_id)}:{}),deleteDelay:Number(v.deleteDelay??v.delete_delay)||5,claimTimeout:Number(v.claimTimeout??v.claim_timeout)||86400,requireAvatar:!!(v.requireAvatar??v.require_avatar),requireUsername:!!(v.requireUsername??v.require_username),...(v.requiredChannel??v.required_channel?{requiredChannel:String(v.requiredChannel??v.required_channel)}:{}),allowBots:!!(v.allowBots??v.allow_bots),participants:Array.isArray(v.participants)?v.participants.map((p:any)=>({userId:String(p.userId??p.user_id),...(p.username?{username:String(p.username)}:{}),...(p.firstName??p.first_name?{firstName:String(p.firstName??p.first_name)}:{}),...(p.lastName??p.last_name?{lastName:String(p.lastName??p.last_name)}:{}),joinedAt:Number(p.joinedAt??p.joined_at)||Date.now()})):[],winners:Array.isArray(v.winners)?v.winners.map((w:any)=>({...w,userId:String(w.userId??w.user_id),joinedAt:Number(w.joinedAt??w.joined_at??w.assignedAt??w.assigned_at)||Date.now(),status:["prepared","sent","claimed","expired"].includes(w.status)?w.status:"prepared",assignedAt:Number(w.assignedAt??w.assigned_at)||Date.now(),expiresAt:Number(w.expiresAt??w.expires_at)||Date.now()+86400000})):[]};}

async function migrate(ctx:PluginContext){const state=await store(ctx).read();if(state.importedLegacy)return;const activities={...state.activities},warehouses={...state.warehouses};
  try{const legacy=ctx.storage.sqlite("lottery.db",{readonly:true});const rows=await legacy.read(db=>({configs:db.prepare("SELECT * FROM lottery_config").all() as any[],participants:db.prepare("SELECT * FROM lottery_participants").all() as any[],winners:db.prepare("SELECT * FROM lottery_winners").all() as any[],prizes:db.prepare("SELECT * FROM prize_warehouse ORDER BY order_index,id").all() as any[]}));for(const row of rows.configs){const a=normalizedActivity(row);if(!a)continue;const legacyId=String(row.id);a.participants=rows.participants.filter(p=>String(p.lottery_id)===legacyId).map((p:any)=>({userId:String(p.user_id),...(p.username?{username:String(p.username)}:{}),...(p.first_name?{firstName:String(p.first_name)}:{}),...(p.last_name?{lastName:String(p.last_name)}:{}),joinedAt:Number(p.joined_at)||a.createdAt}));a.winners=rows.winners.filter(w=>String(w.lottery_id)===legacyId).map((w:any)=>({userId:String(w.user_id),...(w.username?{username:String(w.username)}:{}),...(w.first_name?{firstName:String(w.first_name)}:{}),...(w.last_name?{lastName:String(w.last_name)}:{}),...(w.prize_text?{prize:String(w.prize_text)}:{}),joinedAt:Number(w.joined_at??w.assigned_at)||a.createdAt,status:w.status==="sent"?"sent":w.status==="claimed"?"claimed":w.status==="expired"?"expired":"prepared",assignedAt:Number(w.assigned_at)||a.createdAt,expiresAt:Number(w.expires_at)||a.createdAt+a.claimTimeout*1000}));activities[a.id]=a;}for(const p of rows.prizes){const name=String(p.warehouse_name);(warehouses[name]??=[]).push({text:String(p.prize_text),stock:Number(p.stock_count)||0,order:Number(p.order_index)||0});}}catch{/* Fresh installs have no legacy database. */}
  for(const [id,value] of Object.entries(activities)){const a=normalizedActivity(value);if(a)activities[id]=a;}
  await store(ctx).update(value=>({...value,schemaVersion:1,activities,warehouses,settings:{...defaults.settings,...value.settings},importedLegacy:true}));}

async function send(ctx:PluginContext,peer:any,text:string,replyTo?:number){return ctx.telegram.withClient(async client=>client.sendMessage(peer,{message:text,parseMode:"html",...(replyTo?{replyTo}:{})}));}
async function deleteLater(ctx:PluginContext,message:MessageEnvelope,ids:number[],seconds:number,key:string){await ctx.tasks.run(`lottery:delete:${key}`,async signal=>{await sleep(Math.max(0,seconds)*1000,undefined,{signal});await ctx.telegram.withClient(async client=>client.deleteMessages(returnBigInt(message.chatId),ids,{revoke:true}));});}
function display(p:Participant){return esc(p.username?`@${p.username}`:[p.firstName,p.lastName].filter(Boolean).join(" ")||p.userId);}
async function eligible(ctx:PluginContext,message:MessageEnvelope,a:Activity){return ctx.telegram.withClient(async client=>{const raw=message.raw as any;const sender:any=raw?.sender??await client.getEntity(returnBigInt(message.senderId!));if(sender?.bot&&!a.allowBots)return; if(a.requireUsername&&!sender?.username)return;if(a.requireAvatar&&(!sender?.photo||sender.photo.className==="UserProfilePhotoEmpty"))return;if(a.requiredChannel){try{const {Api}=await import("teleproto");await client.invoke(new Api.channels.GetParticipant({channel:await client.getInputEntity(a.requiredChannel),participant:await client.getInputEntity(returnBigInt(message.senderId!))}));}catch{return;}}return sender;});}
function getWarehouseByNameOrIndex(identifier: string, warehouses: string[]): string | null {
  // Try as index first (1-based)
  const index = parseInt(identifier);
  if (!isNaN(index) && index >= 1 && index <= warehouses.length) {
    return warehouses[index - 1];
  }

  // Try as name
  if (warehouses.includes(identifier)) {
    return identifier;
  }

  return null;
}


async function isUserAdmin(client: any, chatId: string, userId: string): Promise<boolean> {
  const {Api}=await import("teleproto");
  try {
    const chatEntity = await client.getEntity(chatId);

    // 检查是否为超级群或频道
    if (chatEntity.className === 'Channel' || (chatEntity as any).megagroup) {
      try {
        const participant = await client.invoke(
          new Api.channels.GetParticipant({
            channel: chatEntity,
            participant: userId,
          })
        );

        if (participant && participant.participant) {
          const participantType = participant.participant.className;
          return participantType === 'ChannelParticipantAdmin' ||
                 participantType === 'ChannelParticipantCreator';
        }
      } catch (e) {
        // 如果GetParticipant失败，可能是普通群组，尝试其他方法
      }
    }

    // 对于普通群组，尝试获取消息发送者的权限
    try {
      const chatAdmins = await client.invoke(
        new Api.channels.GetParticipants({
          channel: chatEntity,
          filter: new Api.ChannelParticipantsAdmins(),
          offset: 0,
          limit: 200,
          hash: returnBigInt(0)
        })
      );

      if (chatAdmins && (chatAdmins as any).participants) {
        return (chatAdmins as any).participants.some((p: any) =>
          String(p.userId || p.user_id) === String(userId)
        );
      }
    } catch (e) {
      // 如果仍然失败，返回false
    }

    return false;
  } catch (error) {
    return false;
  }
}

async function draw(ctx:PluginContext,activityId:string){let activity:Activity|undefined;
  await store(ctx).update(state=>{const found=state.activities[activityId];if(!found||found.status!=="active")return state;activity=structuredClone(found);activity.status="drawing";return{...state,activities:{...state.activities,[activityId]:activity}};});if(!activity)return false;
  try{const shuffled=[...activity.participants];for(let i=shuffled.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}const selected=shuffled.slice(0,Math.min(activity.winnerCount,shuffled.length));let winners:Winner[]=[];
    await store(ctx).update(state=>{const prizes=(state.warehouses[activity!.warehouse]??[]).map(p=>({...p}));winners=selected.map(p=>{const prize=prizes.find(x=>x.stock>0);if(prize)prize.stock--;return{...p,...(prize?{prize:prize.text}:{}),status:"prepared",assignedAt:Date.now(),expiresAt:Date.now()+activity!.claimTimeout*1000};});const updated={...state.activities[activityId],status:"completed" as const,winners};return{...state,warehouses:{...state.warehouses,[activity!.warehouse]:prizes},activities:{...state.activities,[activityId]:updated}};});
    for(const winner of winners){ctx.signal.throwIfAborted();try{const sent=await send(ctx,returnBigInt(winner.userId),`🎉 <b>恭喜中奖</b>\n活动：${esc(activity.title)}\n奖品：${esc(winner.prize??"请联系发奖者")}`);await store(ctx).update(state=>{const a={...state.activities[activityId],winners:state.activities[activityId].winners.map(w=>w.userId===winner.userId?{...w,status:"sent" as const,messageId:sent.id}:w)};return{...state,activities:{...state.activities,[activityId]:a}};});}catch(e){ctx.log.error("lottery:notify",{userId:winner.userId,error:error(e).slice(0,200)});}}
    if(activity.messageId)await ctx.telegram.withClient(async client=>client.deleteMessages(returnBigInt(activity!.chatId),[activity!.messageId!],{revoke:true})).catch(()=>{});
    const published=(await store(ctx).read()).activities[activityId].winners;
    await send(ctx,returnBigInt(activity.chatId),`🎊 <b>开奖结果</b>\n\n🏆 ${esc(activity.title)}\n${published.length?published.map(w=>`• ${display(w)} — ${w.status==="sent"?"已私聊发放":"待领取"}`).join("\n"):"没有用户参与抽奖"}`);return true;
  }catch(e){await store(ctx).update(state=>{const a=state.activities[activityId];return a?.status==="drawing"?{...state,activities:{...state.activities,[activityId]:{...a,status:"active"}}}:state;});throw e;}}

const guarded = (operation: CommandDefinition["handle"]): CommandDefinition["handle"] => async (i, ctx) => {
  try { await operation(i, ctx); }
  catch(e) { if (!ctx.signal.aborted) await ctx.telegram.edit(i.message, `操作失败：<code>${esc(error(e))}</code>`, {parseMode: "html"}); }
};
const withState = (operation: (i: CommandInvocation, ctx: PluginContext, state: State) => Promise<void>): CommandDefinition["handle"] => guarded(async (i, ctx) => operation(i, ctx, await store(ctx).read()));
const withPrize = (operation: (i: CommandInvocation, ctx: PluginContext, state: State, name: string) => Promise<void>): CommandDefinition["handle"] => withState(async (i, ctx, state) => {
  const message = i.message;
  if (!message.saved && !(message.raw as any)?.isPrivate && message.chatId !== message.senderId) throw new Error("奖品仓库管理只能在私聊或收藏夹中进行");
  await operation(i, ctx, state, i.args[0] ?? "default");
});
const withActive = (operation: (i: CommandInvocation, ctx: PluginContext, active: Activity) => Promise<void>): CommandDefinition["handle"] => withState(async (i, ctx, state) => {
  const active = current(state, i.message.chatId);
  if (!active) throw new Error("当前聊天没有进行中的抽奖");
  await operation(i, ctx, active);
});
const withLatest = (manage: boolean, operation: (i: CommandInvocation, ctx: PluginContext, last: Activity) => Promise<void>): CommandDefinition["handle"] => withState(async (i, ctx, state) => {
  const last = latest(state, i.message.chatId);
  if (!last) throw new Error("当前聊天没有抽奖记录");
  if (manage && last.creatorId && last.creatorId !== i.message.senderId) throw new Error("只有创建者可以管理领奖状态");
  await operation(i, ctx, last);
});
const command: CommandDefinition = {
  helpArgs: ["help"], helpOnEmpty: true, description: "创建和管理抽奖", ignoreEdited: true, subcommandsCaseSensitive: false,
  subcommands: {
    prize: {description: "管理奖品仓库，仅限私聊或收藏夹", subcommands: {
      create: {description: "创建奖品仓库", args: "[仓库名]", examples: [{args: "create myprizes"}, {args: "create vip"}], handle: withPrize(async ({message, args}, ctx, state, name) => {
        await store(ctx).update(v=>({...v,warehouses:{...v.warehouses,[name]:v.warehouses[name]??[]}}));await ctx.telegram.edit(message,`奖品仓库已就绪：<code>${esc(name)}</code>`,{parseMode:"html"});return;
      })},
      add: {description: "添加奖品与库存", args: "仓库名 奖品内容 数量", examples: [{args: 'add myprizes "iPhone 15 Pro" 1'}, {args: 'add myprizes "现金红包100元" 5'}, {args: 'add vip "VIP会员1个月" 10'}, {args: 'add vip "VIP会员1年" 1'}], handle: withPrize(async ({message, args}, ctx, state, name) => {
        const stock=Number(args.at(-1)),text=args.slice(1,-1).join(" ").replace(/^"|"$/g,"");if(!text||!Number.isSafeInteger(stock)||stock<1)throw new Error("用法：lottery prize add 仓库 奖品 数量");await store(ctx).update(v=>({...v,warehouses:{...v.warehouses,[name]:[...(v.warehouses[name]??[]),{text,stock,order:(v.warehouses[name]?.length??0)}]}}));await ctx.telegram.edit(message,"奖品已添加。");return;
      })},
      list: {description: "查看仓库中的奖品及库存", args: "[仓库名]", examples: [{args: "list vip"}], handle: withPrize(async ({message, args}, ctx, state, name) => {
        const list=state.warehouses[name]??[];await ctx.telegram.edit(message,list.length?list.map((x,i)=>`${i+1}. ${esc(x.text)}（${x.stock}）`).join("\n"):"仓库为空",{parseMode:"html"});return;
      })},
      clear: {description: "清空指定仓库", args: "[仓库名]", alternates: [{args: "all", description: "清空所有仓库"}], handle: withPrize(async ({message, args}, ctx, state, name) => {
        await store(ctx).update(v=>({...v,warehouses:args[0]==="all"?{}:{...v.warehouses,[name]:[]}}));await ctx.telegram.edit(message,"奖品仓库已清空。");return;
      })},
    }, help: [{heading: "仓库与奖品：", body: "仓库名省略时使用 default（add 需要明确仓库位置）；奖品内容支持空格和双引号，数量须为正整数。开奖按库存顺序扣减，库存与中奖记录一并持久化。"}],
      handle: withPrize(async () => { throw new Error("未知奖品命令"); })},
    create: {description: "创建当前聊天的抽奖活动", args: "标题 关键词 人数 中奖数 仓库名或序号 [notify]",
      arguments: [
        {name: "标题", required: true, description: "一个词，可使用中文、英文或表情"},
        {name: "关键词", required: true, description: "参与者须准确发送，区分大小写"},
        {name: "人数", required: true, description: "参与上限，默认允许 2–1000 人，达到后立即自动开奖"},
        {name: "中奖数", required: true, description: "正整数，不能超过参与人数"},
        {name: "仓库", required: true, description: "先创建仓库并添加库存；支持按排序后的仓库序号选择"},
        {name: "notify", description: "创建活动后置顶时通知群成员"},
      ],
      examples: [{args: "create 新年抽奖 抽奖 100 5 myprizes"}, {args: "create 新年抽奖 抽奖 100 5 myprizes notify"}, {args: "create iPhone大奖 888 50 1 myprizes"}, {args: "create 红包雨 💰 200 20 cash"}],
      subcommands: {list: {caseSensitive: true, description: "查看可用奖品仓库及库存", args: "", examples: [{args: "list"}], handle: withState(async ({message}, ctx, state) => {
const rows=Object.entries(state.warehouses).sort(([a],[b])=>a<b?-1:a>b?1:0);await ctx.telegram.edit(message,rows.length?rows.map(([name,items],i)=>`${i+1}. <code>${esc(name)}</code>（库存 ${items.reduce((n,x)=>n+x.stock,0)}）`).join("\n"):"没有可用奖品仓库",{parseMode:"html"});return;
      })}},
      handle: withState(async ({message, args}, ctx, state) => {
        const active = current(state, message.chatId);
if(active)throw new Error("当前聊天已有进行中的抽奖");const title=args[0],keyword=args[1],max=Number(args[2]),count=Number(args[3]),warehouse=getWarehouseByNameOrIndex(args[4]??"default",Object.keys(state.warehouses).sort());if(!warehouse)throw new Error("奖品仓库不存在，请使用仓库名称或序号");if(!title||!keyword||!Number.isSafeInteger(max)||!Number.isSafeInteger(count)||count<1||max<count||max<state.settings.minUsers||max>state.settings.maxUsers)throw new Error("创建参数无效");if(!(state.warehouses[warehouse]??[]).some(x=>x.stock>0))throw new Error("奖品仓库不存在或库存为空");const id=randomUUID(),a:Activity={id,chatId:message.chatId,title,keyword,maxParticipants:max,winnerCount:count,warehouse,creatorId:String(message.senderId??""),createdAt:Date.now(),status:"active",deleteDelay:5,claimTimeout:86400,requireAvatar:false,requireUsername:false,allowBots:false,participants:[],winners:[]};const sent=await send(ctx,(message.raw as any)?.peerId??returnBigInt(message.chatId),`🎉 <b>抽奖活动已创建</b>\n活动：${esc(title)}\n关键词：<code>${esc(keyword)}</code>\n名额：${count}/${max}`,message.id);a.messageId=sent.id;await store(ctx).update(v=>({...v,activities:{...v.activities,[id]:a}}));await ctx.telegram.withClient(async client=>client.pinMessage((message.raw as any)?.peerId??returnBigInt(message.chatId),sent.id,{notify:args.includes("notify")})).catch(()=>{});await ctx.telegram.edit(message,`抽奖已创建：<code>${esc(id)}</code>`,{parseMode:"html"});return;
      })},
    status: {description: "查看当前抽奖状态", args: "", handle: withActive(async ({message}, ctx, active) => {
await ctx.telegram.edit(message,`<b>${esc(active.title)}</b>\n关键词：<code>${esc(active.keyword)}</code>\n进度：${active.participants.length}/${active.maxParticipants}`,{parseMode:"html"});return;
    })},
    list: {description: "查看参与用户列表", args: "", handle: withActive(async ({message}, ctx, active) => {
await ctx.telegram.edit(message,active.participants.length?active.participants.map((p,i)=>`${i+1}. ${display(p)}`).join("\n"):"暂无参与用户",{parseMode:"html"});return;
    })},
    draw: {description: "手动开奖（创建者或群组管理员）", args: "", handle: withActive(async ({message}, ctx, active) => {
if(active.creatorId!==message.senderId&&!await ctx.telegram.withClient(client=>isUserAdmin(client,message.chatId,String(message.senderId))))throw new Error("只有抽奖创建者或群组管理员可以手动开奖");await ctx.telegram.edit(message,"正在开奖…");await draw(ctx,active.id);return;
    })},
    delete: {aliases: ["cancel"], description: "取消活动（创建者或群组管理员）", args: "", handle: withActive(async ({message}, ctx, active) => {
if(active.creatorId!==message.senderId&&!await ctx.telegram.withClient(client=>isUserAdmin(client,message.chatId,String(message.senderId))))throw new Error("只有抽奖创建者或群组管理员可以删除活动");await store(ctx).update(v=>({...v,activities:{...v.activities,[active.id]:{...active,status:"cancelled"}}}));await ctx.telegram.edit(message,"抽奖已取消。");return;
    })},
    winners: {description: "查看中奖名单和领奖状态", args: "", handle: withLatest(false, async ({message, args}, ctx, last) => {
await ctx.telegram.edit(message,last.winners.length?last.winners.map(w=>`${display(w)} (${w.status})`).join("\n"):"暂无中奖记录",{parseMode:"html"});return;
    })},
    claim: {description: "由创建者标记用户已领奖", args: "用户ID或@用户名", examples: [{args: "claim @username"}], handle: withLatest(true, async ({message, args}, ctx, last) => {
const target=(args[0]??"").replace(/^@/,"");if(!target)throw new Error("请提供中奖用户 ID 或用户名");let changed=false;await store(ctx).update(v=>{const a=v.activities[last.id],winners=a.winners.map(w=>(w.userId===target||w.username===target)?(changed=true,{...w,status:"claimed" as const}):w);return{...v,activities:{...v.activities,[last.id]:{...a,winners}}};});if(!changed)throw new Error("未找到中奖用户");await ctx.telegram.edit(message,"已标记为已领奖。");return;
    })},
    expire: {description: "由创建者处理过期且未完成通知的奖品", args: "", handle: withLatest(true, async ({message, args}, ctx, last) => {
let changed=0;await store(ctx).update(v=>{const a=v.activities[last.id],now=Date.now(),winners=a.winners.map(w=>w.status==="prepared"&&w.expiresAt<=now?(changed++,{...w,status:"expired" as const}):w);return{...v,activities:{...v.activities,[last.id]:{...a,winners}}};});await ctx.telegram.edit(message,`已处理 ${changed} 个过期奖品。`);return;
    })},
  },
  help: [
    {heading: "完整流程：", body: "先在私聊创建奖品仓库并添加奖品，再用 create list 核对仓库，最后在群组创建抽奖。每个聊天同时只能有一个进行中的活动。"},
    {heading: "参与规则：", body: "群内准确发送活动关键词即可参与；默认排除机器人，每人每场只能参与一次，重复发送无效。达到人数上限立即自动开奖，也可由创建者或群组管理员提前 draw。"},
    {heading: "开奖与领奖：", body: "开奖后自动私聊通知中奖者并扣减库存；原活动消息自动删除，开奖结果需手动置顶。winners 查看状态，claim 标记已领奖，expire 处理超过 24 小时仍未完成通知的奖品记录。"},
  ],
  handle: guarded(async (i, ctx) => {
    if (!i.args.length || i.args[0]?.toLowerCase() === "help") { await ctx.telegram.edit(i.message, help(i.prefix), {parseMode: "html"}); return; }
    const active = current(await store(ctx).read(), i.message.chatId);
    if (!active) throw new Error("当前聊天没有进行中的抽奖");
    throw new Error("未知子命令");
  }),
};
const help = (prefix: string) => renderCommandHelp("lottery", command, {prefix, title: "🎰 智能抽奖插件"});
const lotteryPlugin=definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION,id:"lottery",description:"持久化群组抽奖与奖品仓库",commands:{lottery: command},listeners:[{direction:"incoming",edited:false,ignoreCommands:true,async handle(message,ctx){if(!message.senderId||!message.text)return;const state=await store(ctx).read(),a=current(state,message.chatId);if(!a||message.text.trim()!==a.keyword)return;const sender:any=await eligible(ctx,message,a);if(!sender)return;let joined=false,count=0;await store(ctx).update(v=>{const live=v.activities[a.id];if(!live||live.status!=="active"||live.participants.some(p=>p.userId===message.senderId))return v;const p:Participant={userId:message.senderId!,...(sender.username?{username:String(sender.username)}:{}),...(sender.firstName?{firstName:String(sender.firstName)}:{}),...(sender.lastName?{lastName:String(sender.lastName)}:{}),joinedAt:Date.now()};const updated={...live,participants:[...live.participants,p]};joined=true;count=updated.participants.length;return{...v,activities:{...v.activities,[a.id]:updated}};});if(!joined)return;await ctx.telegram.reply(message,`参与成功：${count}/${a.maxParticipants}`);void deleteLater(ctx,message,[message.id],a.deleteDelay,`${a.id}:${message.senderId}`).catch(()=>{});if(count>=a.maxParticipants)await draw(ctx,a.id);}}],settings:ctx=>({id:"lottery",title:"抽奖",description:"抽奖人数与等待设置",category:"插件配置",icon:"🎰",getSchema:()=>[{key:"minUsers",label:"最少参与人数",type:"number",min:2,max:100},{key:"maxUsers",label:"最多参与人数",type:"number",min:2,max:1000},{key:"timeout",label:"等待时间（秒）",type:"number",min:10,max:600}],getValues:async()=>({...(await store(ctx).read()).settings}),setValues:async patch=>{await store(ctx).update(v=>({...v,settings:{minUsers:Number(patch.minUsers??v.settings.minUsers),maxUsers:Number(patch.maxUsers??v.settings.maxUsers),timeout:Number(patch.timeout??v.settings.timeout)}}));}}),async setup(ctx){await migrate(ctx);const state=await store(ctx).read();for(const a of Object.values(state.activities).filter(x=>x.status==="drawing"))await store(ctx).update(v=>({...v,activities:{...v.activities,[a.id]:{...a,status:"active"}}}));}});
export default function createLottery(){return lotteryPlugin;}
