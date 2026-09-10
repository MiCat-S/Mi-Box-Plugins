import path from "node:path";
import {createReadStream} from "node:fs";
import {open,readFile,rename,writeFile} from "node:fs/promises";
import {Readable} from "node:stream";
import {STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp, type CommandDefinition, type CommandInvocation, definePlugin,type MessageEnvelope,type PluginContext} from "telebox/sdk";
type State={schemaVersion:1;username:string;password:string;defaultPath:string;legacyImported:boolean;[key:string]:unknown};
const defaults:State={schemaVersion:1,username:"",password:"",defaultPath:"",legacyImported:false};
const store=(c:PluginContext)=>c.storage.json<State>("credentials-v2.json",defaults);
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[x]!);
const INSTALL="/opt/openlist",BIN=`${INSTALL}/openlist`,SERVICE="/etc/systemd/system/openlist.service",BACKUPS="/opt/openlist_backups";
const commands={systemctl:"/usr/bin/systemctl",mkdir:"/bin/mkdir",rm:"/bin/rm",cp:"/bin/cp",tar:"/usr/bin/tar",install:"/usr/bin/install",chmod:"/bin/chmod",date:"/bin/date"} as const;
async function run(c:PluginContext,cmd:keyof typeof commands,args:string[],options:any={}){return c.processes.run(commands[cmd],args,{timeoutMs:Math.min(options.timeoutMs??30_000,120_000),maxOutputBytes:256*1024,...options});}
async function migrate(c:PluginContext){const current=await store(c).read();if(current.legacyImported)return;let legacy:any={};try{legacy=JSON.parse(await (await import("node:fs/promises")).readFile(c.files.dataPath("credentials.json"),"utf8"));}catch{}await store(c).update(v=>({...v,username:v.username||String(legacy.username??""),password:v.password||String(legacy.password??""),defaultPath:v.defaultPath||String(legacy.defaultPath??""),legacyImported:true}));}
async function api(c:PluginContext,url:string,init:RequestInit){return c.http.withResponse(url,init,async(r,s)=>{const reader=r.body?.getReader();if(!reader)throw new Error("OpenList 返回空响应");const chunks:Buffer[]=[];let total=0;try{for(;;){s.throwIfAborted();const x=await reader.read();if(x.done)break;total+=x.value.length;if(total>1024*1024)throw new Error("OpenList 响应过大");chunks.push(Buffer.from(x.value));}}finally{reader.releaseLock();}let data:any;try{data=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new Error("OpenList 返回无效 JSON");}if(!r.ok)throw new Error(`HTTP ${r.status}`);if(data?.code!==200)throw new Error(typeof data?.message==="string"?"OpenList 操作失败":"OpenList 响应结构异常");return data.data;},{timeoutMs:30_000,redirects:{allowedHosts:["127.0.0.1"],maxRedirects:0}});}
async function token(c:PluginContext){const s=await store(c).read();if(!s.username||!s.password)throw new Error("请先配置 OpenList 账号");const data=await api(c,"http://127.0.0.1:5244/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:s.username,password:s.password})});if(typeof data?.token!=="string"||!data.token)throw new Error("OpenList 登录响应无令牌");return data.token;}
const safePath=(v:string)=>{const normalized=path.posix.normalize(v.startsWith("/")?v:`/${v}`);if(!normalized.startsWith("/")||normalized.includes("\0"))throw new Error("目标路径无效");return normalized;};
async function status(c:PluginContext){try{const r=await run(c,"systemctl",["is-active","openlist"],{timeoutMs:10_000});return r.stdout.toString().trim()==="active"?"OpenList 服务运行中。":"OpenList 服务未运行。";}catch{return"OpenList 服务未运行或未安装。";}}
async function admin(c:PluginContext,sub:"setuser"|"setpass"|"random",value?:string){const command=sub==="setuser"?["admin","setuser",value??""]:sub==="setpass"?["admin","set",value??""]:["admin","random"];if(command.at(-1)==="")throw new Error("缺少新凭据");const out=(await c.processes.run(BIN,command,{cwd:INSTALL,timeoutMs:30_000,maxOutputBytes:64*1024})).stdout.toString();let username=sub==="setuser"?value??"":"",password=sub==="setpass"?value??"":"";if(sub==="random"){username=out.match(/username:\s*(\S+)/i)?.[1]??"";password=out.match(/password:\s*(\S+)/i)?.[1]??"";}if(username||password)await store(c).update(v=>({...v,username:username||v.username,password:password||v.password}));return"管理命令执行成功，凭据已同步且密码不回显。";}
async function setPort(c:PluginContext,value:string|undefined){const port=Number(value);if(!Number.isInteger(port)||port<1||port>65535)throw new Error("端口必须是 1 到 65535 的整数");const config=`${INSTALL}/data/config.json`,backup=`${config}.previous`,temporary=`${config}.mibot-new`;let stopped=false;await run(c,"cp",["-a",config,backup]);try{const document=JSON.parse(await readFile(config,"utf8"));if(!document?.scheme||typeof document.scheme!=="object")throw new Error("OpenList 配置结构异常");document.scheme.http_port=port;await writeFile(temporary,`${JSON.stringify(document,null,2)}\n`,{mode:0o600,flag:"wx"});await run(c,"systemctl",["stop","openlist"]);stopped=true;await rename(temporary,config);await run(c,"systemctl",["start","openlist"]);return`OpenList 端口已修改为 ${port}。`;}catch(error){await run(c,"rm",["-f",temporary]).catch(()=>undefined);if(stopped){await run(c,"cp",["-a",backup,config]).catch(()=>undefined);await run(c,"systemctl",["start","openlist"]).catch(()=>undefined);}throw error;}}
async function save(c:PluginContext,m:MessageEnvelope,target?:string){const reply=await c.telegram.getReply(m);const raw:any=reply?.raw;if(!raw?.media)throw new Error("请回复媒体文件");const name=String(raw?.file?.name??raw?.document?.attributes?.find((x:any)=>x?.className==="DocumentAttributeFilename")?.fileName??`media_${reply!.id}`).replace(/[\\/:*?"<>|\x00-\x1f]/g,"_").slice(0,120);const state=await store(c).read(),destination=safePath(path.posix.join(target??state.defaultPath??"/",name)),auth=await token(c);await c.files.withTemp(async(dir,signal)=>{const file=path.join(dir,name),handle=await open(file,"wx");let total=0;try{await c.telegram.withClient(async(client:any)=>{for await(const chunk of client.iterDownload(raw.media,{})){signal.throwIfAborted();total+=chunk.length;if(total>2*1024*1024*1024)throw new Error("媒体超过 2 GiB");await handle.write(chunk);}});}finally{await handle.close();}const stream=Readable.toWeb(createReadStream(file));await api(c,"http://127.0.0.1:5244/api/fs/put",{method:"PUT",headers:{authorization:auth,"file-path":encodeURIComponent(destination),"content-type":"application/octet-stream","as-task":"false"},body:stream as never,...({duplex:"half"} as any)});});return`文件已上传到 <code>${esc(destination)}</code>`;}
async function installOrUpdate(c:PluginContext,update:boolean){if(process.platform!=="linux")throw new Error("此操作仅支持 Linux systemd");const arch:{[k:string]:string}={x64:"amd64",arm64:"arm64",s390x:"s390x",loong64:"loong64"},mapped=arch[process.arch];if(!mapped)throw new Error("不支持当前架构");let snapshot=false;try{await c.files.withTemp(async dir=>{const archive=path.join(dir,"openlist.tar.gz"),service=path.join(dir,"openlist.service"),url=new URL(`https://github.com/OpenListTeam/OpenList/releases/latest/download/openlist-linux-musl-${mapped}.tar.gz`);const bytes=await c.http.withResponse(url,{},async(r,s)=>{if(!r.ok)throw new Error(`HTTP ${r.status}`);const reader=r.body?.getReader();if(!reader)throw new Error("下载为空");const file=await open(archive,"wx");let total=0;try{for(;;){s.throwIfAborted();const x=await reader.read();if(x.done)break;total+=x.value.length;if(total>256*1024*1024)throw new Error("安装包过大");await file.write(x.value);}}finally{await file.close();reader.releaseLock();}return total;},{timeoutMs:120_000,redirects:{allowedHosts:["github.com","objects.githubusercontent.com","release-assets.githubusercontent.com"],maxRedirects:5}});if(!bytes)throw new Error("下载为空");if(update){await run(c,"cp",["-a",BIN,`${BIN}.previous`]);snapshot=true;await run(c,"systemctl",["stop","openlist"],{timeoutMs:20_000});}await run(c,"mkdir",["-p",INSTALL]);await run(c,"tar",["-xzf",archive,"-C",INSTALL],{timeoutMs:120_000});await run(c,"chmod",["0755",BIN]);await writeFile(service,`[Unit]\nDescription=OpenList service\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${INSTALL}\nExecStart=${BIN} server\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n`);await run(c,"install",["-m","0644",service,SERVICE]);await run(c,"systemctl",["daemon-reload"]);await run(c,"systemctl",["enable","--now","openlist"],{timeoutMs:30_000});
if(!update){
  const result=await c.processes.run(BIN,["admin","random"],{cwd:INSTALL,timeoutMs:30_000,maxOutputBytes:64*1024});
  const output=result.stdout.toString()+"\n"+result.stderr.toString();
  const username=output.match(/username:\s*(\S+)/i)?.[1],password=output.match(/password:\s*(\S+)/i)?.[1];
  if(!username||!password)throw new Error("OpenList 服务已安装，初始账号信息未能读取；请使用 op admin random 初始化账号");
  await store(c).update(v=>({...v,username,password}));
}
});}catch(error){if(update&&snapshot){await run(c,"cp",["-a",`${BIN}.previous`,BIN]).catch(()=>undefined);await run(c,"systemctl",["start","openlist"]).catch(()=>undefined);}throw error;}return update?"OpenList 更新完成。":"OpenList 安装完成。";}
const execute = (operation: (i: CommandInvocation, c: PluginContext) => Promise<string>): CommandDefinition["handle"] => async (i, c) => {
  try { await c.telegram.edit(i.message, await operation(i, c), {parseMode: "html"}); }
  catch(e) { if (!c.signal.aborted) await c.telegram.edit(i.message, `❌ ${esc(e instanceof Error ? e.message : "OpenList 操作失败")}`, {parseMode: "html"}); }
};
const saved: NonNullable<CommandDefinition["authorize"]> = async (i, c) => {
  if (i.message.saved) return true;
  if (!c.signal.aborted) await c.telegram.edit(i.message, "❌ 密码仅限在收藏夹中设置", {parseMode: "html"});
  return false;
};
const definition: CommandDefinition = {
  description: "管理 OpenList 服务并上传 Telegram 媒体", subcommandsCaseSensitive: false,
  subcommands: {
    status: {description: "查看服务状态", args: "", handle: execute((_i, c) => status(c))},
    install: {description: "安装 OpenList 并初始化账号", args: "", handle: execute((_i, c) => installOrUpdate(c, false))},
    update: {description: "更新 OpenList", args: "", handle: execute((_i, c) => installOrUpdate(c, true))},
    uninstall: {description: "卸载服务，保留数据目录", args: "", handle: execute(async (_i, c) => {
      await run(c, "systemctl", ["disable", "--now", "openlist"]).catch(() => undefined);
      await run(c, "rm", ["-f", SERVICE]); await run(c, "systemctl", ["daemon-reload"]);
      return "OpenList 服务已卸载，数据目录保留。";
    })},
    login: {description: "保存上传使用的账号信息", args: "用户 密码", authorize: saved,
      help: [{heading: "凭据：", body: "仅限收藏夹；密码支持空格，保存在本机插件数据目录。"}],
      handle: execute(async (i, c) => {
        if (!i.args[0] || !i.args[1]) throw new Error("用法：op login 用户 密码");
        await store(c).update(v => ({...v, username: i.args[0]!, password: i.args.slice(1).join(" ")}));
        return "OpenList 账号已保存。";
      })},
    setdefault: {description: "设置默认上传路径，省略时恢复默认", args: "[路径]", handle: execute(async (i, c) => {
      const value = i.args.join(" "); if (value) safePath(value);
      await store(c).update(v => ({...v, defaultPath: value})); return "默认上传路径已更新。";
    })},
    save: {description: "上传回复的媒体到指定或默认目录", args: "[路径]", examples: [{args: "save /media", description: "回复媒体后上传到指定挂载目录"}],
      help: [{heading: "上传：", body: "单个媒体上限 2 GiB，上传接口连接 http://127.0.0.1:5244，使用已保存的账号登录。"}],
      handle: execute((i, c) => save(c, i.message, i.args[0]))},
    admin: {description: "管理账号并同步本机凭据", subcommandsCaseSensitive: true, subcommands: {
      setuser: {description: "修改用户名", args: "用户名", handle: execute((i, c) => admin(c, "setuser", i.args[0]))},
      setpass: {description: "修改密码，仅限收藏夹", args: "密码", authorize: saved, handle: execute((i, c) => admin(c, "setpass", i.args[0]))},
      random: {description: "生成随机凭据，仅限收藏夹", args: "", authorize: saved, handle: execute((_i, c) => admin(c, "random"))},
    }, help: [{heading: "说明：", body: "调用 /opt/openlist/openlist 的管理命令，成功后同步凭据，密码不回显。用户名和密码参数各取一个词。"}],
      handle: execute(async () => { throw new Error("用法：op admin setuser|setpass|random"); })},
    setport: {description: "修改服务端口并重启", args: "端口", examples: [{args: "setport 5255"}],
      arguments: [{name: "端口", required: true, description: "1–65535 的整数；媒体上传接口当前固定使用本机 5244 端口"}],
      handle: execute((i, c) => setPort(c, i.args[0]))},
    backup: {description: "备份 OpenList 数据目录", args: "", handle: execute(async (_i, c) => {
      await run(c, "mkdir", ["-p", BACKUPS]);
      const stamp = (await run(c, "date", ["+%Y%m%d_%H%M%S"])).stdout.toString().trim(), directory = `${BACKUPS}/backup_${stamp}`;
      await run(c, "mkdir", ["-p", directory]); await run(c, "cp", ["-a", `${INSTALL}/data`, directory], {timeoutMs: 120_000});
      return `备份完成：<code>backup_${esc(stamp)}</code>`;
    })},
    restore: {description: "恢复指定备份并重启服务", args: "备份名", handle: execute(async (i, c) => {
      if (!/^[A-Za-z0-9._-]+$/.test(i.args[0] ?? "")) throw new Error("请提供安全的备份名");
      await run(c, "systemctl", ["stop", "openlist"]);
      try { await run(c, "cp", ["-a", `${BACKUPS}/${i.args[0]}/data`, INSTALL], {timeoutMs: 120_000}); await run(c, "systemctl", ["start", "openlist"]); }
      catch(e) { await run(c, "systemctl", ["start", "openlist"]).catch(() => undefined); throw e; }
      return "OpenList 数据恢复完成。";
    })},
  },
  examples: [{args: "install"}, {args: "status"}],
  help: [{heading: "运行环境：", body: "安装和更新支持 Linux systemd，使用固定目录 /opt/openlist，备份位于 /opt/openlist_backups，服务进程须具有管理这些路径和服务的权限。"},
    {heading: "命令别名：", body: "<code>{prefix}op</code> 与 <code>{prefix}openlist</code> 使用同一套命令。"}],
  handle: execute(async i => help(i.prefix)),
};
const help = (prefix: string) => renderCommandHelp("openlist", definition, {prefix, title: "⚙️ OpenList 管理"});
export default function createOpenlist(){return definePlugin({renderHelp: help, apiVersion: STRUCTURED_PLUGIN_API_VERSION,id:"openlist",description:"OpenList 安装、凭据、备份和媒体上传",resources:{processes:{concurrency:1,queueCapacity:2,timeoutMs:120_000,maxOutputBytes:262144}},commands:{openlist:definition,op:definition},settings:c=>({id:"openlist",title:"OpenList",category:"插件配置",icon:"📁",getSchema:()=>[{key:"username",label:"用户名",type:"string"},{key:"password",label:"密码",type:"password",secret:true},{key:"defaultPath",label:"默认上传路径",type:"string"}],getValues:async()=>{const v=await store(c).read();return{username:v.username,password:v.password,defaultPath:v.defaultPath};},async setValues(p){await store(c).update(v=>{const defaultPath=typeof p.defaultPath==="string"?p.defaultPath:v.defaultPath;if(defaultPath)safePath(defaultPath);return{...v,username:typeof p.username==="string"?p.username:v.username,password:typeof p.password==="string"?p.password:v.password,defaultPath};});}}),setup:migrate});}
