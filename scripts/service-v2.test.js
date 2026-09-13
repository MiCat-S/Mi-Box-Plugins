'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const core=path.resolve(__dirname,'../../TeleBox-Core');
const {buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));
const {PluginHost}=require(path.join(core,'dist/v2/host.js'));
const create=require(path.join(buildPlugin({id:'service',packageRoot:path.resolve(__dirname,'../service'),entry:'v2.ts'}).artifactDir,'index.cjs')).default;

const result=(stdout='',stderr='')=>({stdout:Buffer.from(stdout),stderr:Buffer.from(stderr),code:0,signal:null});
function fixture(runProcess){
 const edits=[],replies=[],runs=[],logs=[],controller=new AbortController();
 const context={signal:controller.signal,telegram:{edit:async(_m,text,options)=>edits.push({text,options}),reply:async(_m,text,options)=>replies.push({text,options})},log:{error(event,fields){logs.push({event,fields});}},processes:{async run(file,args,options){runs.push({file,args,options});return runProcess?runProcess(file,args,options):result('Active: active (running) since Mon\n Main PID: 12\n Memory: 2M');}}};
 return{edits,replies,runs,logs,controller,run:args=>create().commands.service.handle({message:{id:1,chatId:'1',text:'.service',outgoing:true},args,command:'service',prefix:'.'},context)};
}

test('service rejects unsafe names and passes a valid unit only as an argument',async()=>{
 const f=fixture();await f.run(['x;reboot']);assert.equal(f.runs.length,0);assert.match(f.edits[0].text,/非法字符/);
 await f.run(['--help']);await f.run(['-H']);assert.equal(f.runs.length,0);
 await f.run(['demo@blue.service']);assert.deepEqual(f.runs[0].args,['--no-pager','status','--','demo@blue.service']);assert.equal(f.runs[0].file,'/usr/bin/systemctl');
});

test('service discovers the current mibot.service before legacy candidates',async()=>{
 const f=fixture(async(file,args)=>{
  if(file==='/usr/bin/ps')throw new Error('no unit column');
  if(args[0]==='status')throw Object.assign(new Error('pid not managed'),{stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)});
  if(args[0]==='is-active')return result(args[1]==='mibot.service'?'active\n':'inactive\n');
  return result('Active: active (running)\n Main PID: 7');
 });
 await f.run([]);
 assert.deepEqual(f.runs.slice(0,3).map(call=>call.args),[['-o','unit=','-p',String(process.pid)],['status',String(process.pid)],['is-active','mibot.service']]);
 assert.deepEqual(f.runs.at(-1).args,['--no-pager','status','--','mibot.service']);
 assert.match(f.edits.at(-1).text,/mibot\.service 服务详情 \(自动检测\)/);
});

test('service retains the PID status discovery path and translated result',async()=>{
 const f=fixture(async(file,args)=>{
  if(file==='/usr/bin/ps')return result('-\n');
  if(args[0]==='status'&&args.length===2)return result('● my.bot.service - Custom');
  return result('Active: active (running) since Mon\n Main PID: 12\n Memory: 2M');
 });
 await f.run([]);assert.deepEqual(f.runs.at(-1).args,['--no-pager','status','--','my.bot']);assert.match(f.edits.at(-1).text,/my\.bot 服务详情/);assert.match(f.edits.at(-1).text,/活跃 \(运行中\)/);assert.equal(f.edits.at(-1).options.parseMode,'html');
});

test('service interprets inactive and missing units from failed process output',async()=>{
 for(const [text,expected] of [['Active: inactive (dead)','已停止'],['Unit demo.service could not be found','未找到']]){
  const failure=Object.assign(new Error('exit'),{stdout:Buffer.from(text),stderr:Buffer.alloc(0)}),f=fixture(async()=>{throw failure;});await f.run(['demo']);assert.match(f.edits.at(-1).text,new RegExp(expected));
 }
});

test('service does not expose arbitrary process errors in output or logs',async()=>{
 const failure=Object.assign(new Error('SECRET_MESSAGE'),{name:'SECRET_NAME',code:'SECRET_CODE'}),f=fixture(async()=>{throw failure;});await f.run(['demo']);
 assert.equal(f.edits.at(-1).text,'❌ 获取服务详情时发生错误，请稍后重试');assert.deepEqual(f.logs,[{event:'service_status_failed',fields:{kind:'internal'}}]);assert.doesNotMatch(JSON.stringify({edits:f.edits,logs:f.logs}),/SECRET_/);
});

test('service paginates complete long status output within the SDK budget',async()=>{
 const lines=Array.from({length:240},(_,i)=>`Memory: ${i}M available high max`).join('\n'),f=fixture(async()=>result(`Active: active (running)\n${lines}`));await f.run(['demo']);
 const pages=[f.edits.at(-1).text,...f.replies.map(item=>item.text)];assert.ok(pages.length>1);assert.ok(pages.every(page=>page.length<=3500));for(let i=0;i<240;i++)assert.match(pages.join('\n'),new RegExp(`内存: ${i}M`));
});

test('service cancellation after an in-flight detection result starts no fallback process',async()=>{
 let entered,release;const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),f=fixture(async()=>{entered();await gate;return result('-\n');});
 const pending=f.run([]);await ready;f.controller.abort(new DOMException('stop','AbortError'));release();await assert.rejects(pending,{name:'AbortError'});assert.equal(f.runs.length,1);assert.equal(f.edits.length,1);
});

test('service incoming commands are rejected by the real Host before any process can start',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mibot-service-v2-'))),edits=[];
 const host=new PluginHost({storageRoot:root,logger:{info(){},error(){}},telegram:{async edit(_m,text){edits.push(text);},async reply(){},async invoke(){},async getReply(){},async withClient(op,signal){return op({},signal);}}});
 await host.load(create());t.after(async()=>{await host.shutdown(1000);await fs.rm(root,{recursive:true,force:true});});
 assert.equal(await host.dispatchPrimary({id:1,chatId:'-1001',senderId:'77',outgoing:false,text:'.service demo'}),false);assert.deepEqual(edits,[]);
});
