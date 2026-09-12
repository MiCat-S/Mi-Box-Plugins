import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, renderCommandHelp, type CommandDefinition, type MessageEnvelope, type PluginContext} from "telebox/sdk";
import {setTimeout as sleep} from "node:timers/promises";

type UserInfo={id:string;username:string;first_name:string;last_name:string;is_deleted:boolean;last_online:string|null;error_message?:string};
type CacheData={chat_id:string;chat_title:string;mode:string;day:number;search_time:string;total_found:number;users:UserInfo[];expiresAt:number};
type State={schemaVersion:1;entries:Record<string,CacheData>};
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]!);
const store=(ctx:PluginContext)=>ctx.storage.json<State>("clean_member_cache.json",{schemaVersion:1,entries:{}});
const modeName=(m:string,n:number)=>({"1":`未上线超过${n}天的用户`,"2":`未发言超过${n}天的用户`,"3":`发言少于${n}条的用户`,"4":"已注销的账户","5":"所有普通成员"}[m]||"未知");
const csv=(d:CacheData,failed=false)=>{const q=(v:unknown)=>{const raw=String(v??""),safe=/^[=+\-@\t\r]/.test(raw)?`'${raw}`:raw;return `"${safe.replaceAll('"','""')}"`;};const rows=[[failed?"群组清理失败用户报告":"群组清理报告"],["群组名称",d.chat_title],["群组ID",d.chat_id],["清理条件",modeName(d.mode,d.day)],["搜索时间",d.search_time],["符合条件用户数量",String(d.total_found)],[],["用户ID","用户名","姓名","最后上线时间","是否注销",...(failed?["失败原因"]:[])],...d.users.map(u=>[u.id,u.username,`${u.first_name} ${u.last_name}`.trim(),u.last_online||"未知",u.is_deleted?"是":"否",...(failed?[u.error_message||""]:[])])];return "\ufeff"+rows.map(r=>r.map(q).join(",")).join("\n");};
async function saveReport(ctx:PluginContext,d:CacheData,failed=false){const [{open},{randomUUID}]=await Promise.all([import("node:fs/promises"),import("node:crypto")]);const name=`${failed?"failed":"report"}_${d.chat_id}_${d.mode}_${d.day}_${Date.now()}_${randomUUID()}.csv`,path=await ctx.files.dataFile(name),handle=await open(path,"wx",0o600);try{await handle.writeFile(csv(d,failed),"utf8");}finally{await handle.close();}return{path,name};}
function lastDays(u:any){const s=u.status;if(!s)return null;if(["UserStatusOnline","UserStatusRecently"].includes(s.className))return 0;if(s.className==="UserStatusOffline"&&s.wasOnline)return Math.floor((Date.now()-Number(s.wasOnline)*1000)/86400000);if(s.className==="UserStatusLastWeek")return 7;if(s.className==="UserStatusLastMonth")return 30;return null;}
async function isAdmin(client:any,chat:any,Api:any){try{const me=await client.getMe();if(chat.className==="Chat")return !!chat.creator||!!chat.adminRights;const channel=await client.getInputEntity(chat),p=(await client.invoke(new Api.channels.GetParticipant({channel,participant:me.id}))).participant;return p?.className==="ChannelParticipantCreator"||(p?.className==="ChannelParticipantAdmin"&&!!p.adminRights?.banUsers);}catch{return false;}}

async function command(message:MessageEnvelope,args:readonly string[],prefix:string,ctx:PluginContext){
  const mode=(args[0]||"").toLowerCase();
  if(!mode||["help","h"].includes(mode)){await ctx.telegram.edit(message,renderUsage(prefix),{parseMode:"html"});return;}
  if(!/^[1-5]$/.test(mode)){await ctx.telegram.edit(message,`❌ <b>未知模式</b>\n\n支持模式: 1-5\n\n${renderUsage(prefix)}`,{parseMode:"html"});return;}
  let day=0;
  if(["1","2","3"].includes(mode)){
    day=Number(args[1]);
    if(!Number.isInteger(day)||day<1){await ctx.telegram.edit(message,`❌ <b>参数错误</b>\n\n${mode==="3"?"发言数":"天数"}必须为正整数`,{parseMode:"html"});return;}
    if(mode!=="3")day=Math.max(day,7);
  }
  const search=args.some(x=>x.toLowerCase()==="search");
  const limitRaw=args.find(x=>/^limit:/i.test(x))?.split(":")[1],limit=limitRaw?Number(limitRaw):undefined;
  if(limitRaw&&(!Number.isInteger(limit)||(limit??0)<=0)){await ctx.telegram.edit(message,"❌ limit 必须为正整数");return;}
  const target=args.find(x=>/^chat:/i.test(x))?.slice(5);
  await ctx.telegram.withClient(async(client:any,signal)=>{
    const {Api}=await import("teleproto");
    const {returnBigInt}=await import("teleproto/Helpers.js");
    const raw:any=message.raw;
    let chat:any;
    try{chat=await client.getEntity(target||raw?.peerId||message.chatId);}
    catch{await ctx.telegram.edit(message,"❌ <b>错误：</b>无法访问指定群组",{parseMode:"html"});return;}
    if(!["Channel","Chat"].includes(chat.className)){await ctx.telegram.edit(message,"❌ 无法获取群组ID，请在群组中使用或指定chat参数");return;}
    if(!search&&!await isAdmin(client,chat,Api)){await ctx.telegram.edit(message,"❌ 权限不足，需要封禁成员权限",{parseMode:"html"});return;}
    const peer=await client.getInputEntity(chat),chatId=String(chat.id),title=chat.title||"当前群组",key=`${chatId}_${mode}_${day}`;
    if(search){const state=await store(ctx).read(signal),cached=state.entries[key];if(cached&&cached.expiresAt>Date.now()){const report=await saveReport(ctx,cached);await ctx.telegram.edit(message,`✅ 搜索完成（缓存）\n\n📊 找到 ${cached.total_found} 名符合条件用户\n📁 报告文件: <code>${esc(report.name)}</code>`,{parseMode:"html"});return;}}
    await ctx.telegram.edit(message,`📋 <b>群组清理任务启动</b>\n\n🏷️ 群组: <b>${esc(title)}</b>\n🎯 开始${search?"搜索":"清理"}: ${esc(modeName(mode,day))}`,{parseMode:"html"});

    const admins=new Set<string>(),members:any[]=[];
    if(chat.className==="Chat"){
      const full:any=await client.invoke(new Api.messages.GetFullChat({chatId:chat.id}));
      const participants=full?.fullChat?.participants?.participants;
      if(!Array.isArray(participants))throw new Error("无法读取基本群成员");
      for(const participant of participants)if(["ChatParticipantAdmin","ChatParticipantCreator"].includes(participant?.className))admins.add(String(participant.userId));
      members.push(...(Array.isArray(full.users)?full.users:[]));
    }else{
      const adminResult:any=await client.invoke(new Api.channels.GetParticipants({channel:peer,filter:new Api.ChannelParticipantsAdmins(),offset:0,limit:200,hash:returnBigInt(0)}));
      for(const user of adminResult.users||[])admins.add(String(user.id));
      let offset=0;
      while(offset<=50000){
        signal.throwIfAborted();
        const result:any=await client.invoke(new Api.channels.GetParticipants({channel:peer,filter:new Api.ChannelParticipantsRecent(),offset,limit:200,hash:returnBigInt(0)}));
        const page:any[]=Array.isArray(result.users)?result.users:[];
        const pageSize=Array.isArray(result.participants)?result.participants.length:page.length;
        if(!page.length||!pageSize)break;
        members.push(...page);
        if(pageSize<200)break;
        offset+=pageSize;
      }
    }

    let scanned=0,removed=0;
    const users:UserInfo[]=[],failed:UserInfo[]=[];
    for(const u of members){
      signal.throwIfAborted();scanned++;
      const id=String(u.id);
      if(admins.has(id)||u.bot)continue;
      let matched=false;
      if(mode==="1"){const elapsed=lastDays(u);matched=elapsed!==null&&elapsed>day;}
      else if(mode==="4")matched=!!(u.deleted||u.isDeleted);
      else if(mode==="5")matched=true;
      else try{
        const from=await client.getInputEntity(u),result:any=await client.invoke(new Api.messages.Search({peer,q:"",filter:new Api.InputMessagesFilterEmpty(),minDate:mode==="2"?Math.floor(Date.now()/1000)-day*86400:0,maxDate:0,offsetId:0,addOffset:0,limit:1,maxId:0,minId:0,hash:returnBigInt(0),fromId:from}));
        const count=Number(result.count??result.messages?.length??0);matched=mode==="2"?count===0:count<day;
      }catch{continue;}
      if(!matched)continue;
      const info:UserInfo={id,username:u.username||"",first_name:u.firstName||"",last_name:u.lastName||"",is_deleted:!!u.deleted,last_online:u.status?.className==="UserStatusOffline"&&u.status.wasOnline?new Date(Number(u.status.wasOnline)*1000).toISOString():u.status?.className?.replace("UserStatus","").toLowerCase()||null};
      users.push(info);
      if(!search&&(!limit||removed<limit)){
        try{
          const input=await client.getInputEntity(u);
          if(chat.className==="Chat")await client.invoke(new Api.messages.DeleteChatUser({chatId:chat.id,userId:input,revokeHistory:false}));
          else{
            await client.invoke(new Api.channels.EditBanned({channel:peer,participant:input,bannedRights:new Api.ChatBannedRights({viewMessages:true,sendMessages:true,untilDate:Math.floor(Date.now()/1000)+60})}));
            await client.invoke(new Api.channels.EditBanned({channel:peer,participant:input,bannedRights:new Api.ChatBannedRights({untilDate:0})}));
          }
          removed++;
        }catch(error){failed.push({...info,error_message:String((error as any)?.message??error)});}
        await sleep(500,undefined,{signal});
      }
      if(scanned%200===0)await ctx.telegram.edit(message,`📋 <b>群组清理进度</b>\n\n扫描: ${scanned} | 找到: ${users.length}${search?"":` | 已移出: ${removed}`}`,{parseMode:"html"});
    }
    const data:CacheData={chat_id:chatId,chat_title:title,mode,day,search_time:new Date().toISOString(),total_found:users.length,users,expiresAt:Date.now()+86400000};
    await store(ctx).update(state=>{const entries=Object.fromEntries(Object.entries(state.entries).filter(([,value])=>value.expiresAt>Date.now()));entries[key]=data;for(const old of Object.keys(entries).slice(0,Math.max(0,Object.keys(entries).length-50)))delete entries[old];return{schemaVersion:1,entries};},signal);
    const report=await saveReport(ctx,data);
    if(failed.length){const failedData={...data,total_found:failed.length,users:failed};const failedReport=await saveReport(ctx,failedData,true);try{await client.sendFile("me",{file:failedReport.path,caption:`清理失败用户报告：${failed.length} 人`});}catch{ctx.log.error("clean_member:failed-report");}}
    const rate=users.length?((removed/users.length)*100).toFixed(1):"0";
    await ctx.telegram.edit(message,search?`✅ <b>搜索完成</b> - ${esc(modeName(mode,day))}\n\n📊 扫描人数: <code>${scanned}</code> 人\n🎯 符合条件: <code>${users.length}</code> 人\n📁 报告文件: <code>${esc(report.name)}</code>`:`🎉 <b>清理完成</b> - ${esc(modeName(mode,day))}\n\n📊 扫描人数: <code>${scanned}</code> 人\n🎯 符合条件: <code>${users.length}</code> 人\n✅ 成功移出: <code>${removed}</code> 人\n❌ 失败/跳过: <code>${users.length-removed}</code> 人\n📈 成功率: <code>${rate}%</code>\n📁 报告文件: <code>${esc(report.name)}</code>`,{parseMode:"html"});
  });
}

const cleanMemberCommand: CommandDefinition = {
  description: "群成员清理",
  helpArgs: ["help", "h"],
  helpOnEmpty: true,
  ignoreEdited: true,
  args: "模式 [参数] [chat:群组ID] [limit:数量] [search]",
  arguments: [
    {name: "模式", required: true, description: "1 未上线超过N天 · 2 未发言超过N天 · 3 发言少于N条 · 4 已注销账号 · 5 所有普通成员"},
    {name: "参数", description: "模式 1/2/3 需要正整数 N；模式 4/5 不需要参数"},
    {name: "chat:群组ID", description: "指定可访问的群组，省略时使用当前对话"},
    {name: "limit:数量", description: "最多成功移出数量；不缩小搜索范围"},
    {name: "search", description: "仅搜索并生成报告；省略时直接执行移出"},
  ],
  examples: [
    {args: "1 30 search", description: "查看超过 30 天未上线的成员"},
    {args: "1 30 limit:10", description: "按条件重新查询，最多移出 10 人"},
    {args: "4 chat:-1001234567890 search", description: "搜索指定群的注销账号"},
    {args: "3 5 search", description: "搜索发言少于 5 条的成员"},
  ],
  help: [
    {heading: "模式：", body: "模式 1/2/3 的参数须为正整数；模式 1、2 输入小于 7 时自动调整为 7 天；模式 1 最后上线未知时跳过。模式 4 已注销账号、模式 5 所有普通成员均无需额外参数。"},
    {heading: "范围与权限：", body: "查询会跳过识别到的管理员与机器人；上线状态与发言统计受 Telegram 可见数据限制。执行移出需要群主身份或封禁成员权限，搜索需要能够访问群组和相关数据。超级群通过短暂封禁后立即解封来移出成员；基本群使用移除成员接口。"},
    {heading: "limit 与缓存：", body: "limit:N 只限制成功移出人数，不缩小搜索范围；找到的人数可能大于实际移出人数，需结合 limit、失败和跳过统计查看。相同群组、模式和参数的搜索结果可复用 24 小时缓存；实际清理会重新查询。"},
    {heading: "报告：", body: "CSV 报告以唯一文件名保存在插件数据目录，完成回执只显示文件名；失败用户报告会尝试发送到收藏夹。"},
    {heading: "常见提示：", body: "权限不足或无法访问群组时，核对账号权限和 chat 参数。"},
  ],
  async handle({message,args,prefix},ctx){try{await command(message,args,prefix,ctx);}catch{if(!ctx.signal.aborted){ctx.log.error("clean_member_failed");await ctx.telegram.edit(message,"❌ 处理失败，请检查群组权限、参数和 Telegram 状态");}}},
};
const renderUsage = (prefix: string) => renderCommandHelp("clean_member", cleanMemberCommand, {prefix});

export default function createCleanMember(){
  return definePlugin({apiVersion:STRUCTURED_PLUGIN_API_VERSION,id:"clean_member",description:"按活跃度、发言数或账户状态搜索并清理群成员",
    renderHelp: prefix => renderCommandHelp("clean_member", cleanMemberCommand, {prefix, title: "🧹 群成员清理工具 Pro"}),
    commands:{clean_member: cleanMemberCommand}});
}
