'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const core=path.resolve(__dirname,'../../TeleBox-Core');
const {buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));
const {PluginHost}=require(path.join(core,'dist/v2/host.js'));
const {Api}=require(path.join(core,'node_modules/teleproto'));
const built=buildPlugin({id:'checkin',packageRoot:path.resolve(__dirname,'../checkin'),entry:'v2.ts'});
const create=require(path.join(built.artifactDir,'index.cjs')).default;

function fixture(options={}){
  const initial=structuredClone(options.state??{schemaVersion:1,runTime:'10:00',runTimeEnd:'11:30',randomDelay:0,logChat:'',botToken:'',pushChatId:'',targets:[],lastRunDate:'',pending:{},legacyImported:true});
  const states={state:initial,checkin_config:structuredClone(options.legacy??{})};let tail=Promise.resolve();
  const edits=[],replies=[],sent=[],invokes=[],requests=[],logs=[];let active=0,peak=0;
  const client={
    async sendMessage(peer,value){sent.push({peer,value});if(value.message==='请回复此消息发送签到命令')return{id:91};active++;peak=Math.max(peak,active);if(options.sendError?.[peer]){active--;throw options.sendError[peer];}active--;return{id:10};},
    async getMessages(peer){return options.messages?.[peer]??[{id:11,date:Math.floor(Date.now()/1000),out:false,message:'done'}];},
    async invoke(value){invokes.push(value);return{};},
  };
  const context={signal:new AbortController().signal,tasks:{},commands:{parse(){}},jobs:{},services:{},processes:{},files:{},
    log:{info(){},error(event,fields){logs.push({event,fields});}},
    storage:{json(name){const key=name.replace('.json','');return{read(){return tail.then(()=>structuredClone(states[key]??{}));},update(fn){const out=tail.then(async()=>{states[key]=await fn(structuredClone(states[key]??{}));return structuredClone(states[key]);});tail=out.then(()=>undefined,()=>undefined);return out;}};}},
    telegram:{async edit(message,text,settings){edits.push({message,text,settings});},async reply(message,text,settings){replies.push({message,text,settings});},async getReply(){return undefined;},async withClient(fn){return fn(client,context.signal);}},
    http:{async withResponse(url,init,consume,settings){requests.push({url:String(url),init,settings});const response=new Response(JSON.stringify({ok:true}),{status:options.botStatus??200,headers:{'content-type':'application/json'}});return consume(response,context.signal);}}
  };
  const plugin=create();const message=(text='.checkin',extra={})=>({id:1,chatId:'100',senderId:'1',outgoing:true,text,...extra});
  return{plugin,context,edits,replies,sent,invokes,requests,logs,states,peak:()=>peak,
    setup:()=>plugin.setup(context),run:(text,extra={})=>plugin.commands.checkin.handle({command:'checkin',prefix:'.',args:text.trim().split(/\s+/).slice(1),message:message(text,extra)},context),
    listen:(text,extra={})=>plugin.listeners[0].handle(message(text,extra),context),job:()=>plugin.jobs.daily_check.handle(context,context.signal)};
}

test('artifact declares a stable Shanghai job and Layer 229 dependency',()=>{
  assert.deepEqual(built.manifest.imports,['telebox/sdk','teleproto']);const p=create();
  assert.equal(p.jobs.daily_check.cron,'* * * * *');assert.equal(p.jobs.daily_check.timeZone,'Asia/Shanghai');
});

test('legacy configuration migrates once, normalizes targets and preserves unknown fields',async()=>{
  const f=fixture({state:{},legacy:{runTime:'22:00',runTimeEnd:'02:00',botToken:'secret',future:{keep:true},targets:[{id:'a',name:'A',target:'@a',command:'/sign',enabled:true},{id:'a',name:'dup',target:'@b',command:'/x'}]}});
  await f.setup();await f.setup();assert.equal(f.states.state.schemaVersion,1);assert.equal(f.states.state.runTime,'22:00');assert.equal(f.states.state.runTimeEnd,'02:00');
  assert.equal(f.states.state.targets.length,1);assert.deepEqual(f.states.state.future,{keep:true});assert.equal(f.states.state.legacyImported,true);
});

test('reply-style add persists the full command and target management stays idempotent',async()=>{
  const f=fixture();await f.run('.checkin add storm Storm @storm_bot data:checkin');assert.equal(f.states.state.pending['100'].promptId,91);
  await f.listen('/sign account 123',{replyToId:91});assert.equal(f.states.state.targets[0].command,'/sign account 123');assert.equal(f.states.state.targets[0].callbackData,'checkin');
  await f.run('.checkin toggle storm');assert.equal(f.states.state.targets[0].enabled,false);await f.run('.checkin del storm');assert.equal(f.states.state.targets.length,0);
});

test('Bot token command is restricted to Saved Messages and output/settings mask it',async()=>{
  const f=fixture();await f.run('.checkin set bot 12345:ABC -100');assert.match(f.edits.at(-1).text,/只能在收藏夹/);assert.equal(f.states.state.botToken,'');
  await f.run('.checkin set bot 12345:ABC -100',{saved:true});assert.equal(f.states.state.botToken,'12345:ABC');assert.doesNotMatch(f.edits.at(-1).text,/12345:ABC/);
  const adapter=f.plugin.settings(f.context);assert.equal((await adapter.getValues()).botToken,'***');assert.equal(adapter.getSchema().find(x=>x.key==='botToken').secret,true);
});

test('manual run clicks Layer 229 callback bytes and Bot push is host-locked with no redirects',async()=>{
  const payload=Buffer.from('checkin');const button=new Api.KeyboardInlineButton({text:'Sign',type:new Api.InlineButtonTypeCallback({data:payload})});
  const markup=new Api.ReplyInlineMarkup({rows:[new Api.KeyboardInlineButtonRow({buttons:[button]})]});
  const f=fixture({state:{schemaVersion:1,runTime:'10:00',randomDelay:0,logChat:'',botToken:'123:abc',pushChatId:'-100',targets:[{id:'a',name:'A',target:'@a',command:'/sign',callbackData:'checkin',enabled:true}],lastRunDate:'',pending:{},legacyImported:true},messages:{'@a':[{id:11,date:Math.floor(Date.now()/1000)+60,out:false,message:'choose',replyMarkup:markup},{id:12,date:Math.floor(Date.now()/1000)+60,out:false,message:'signed'}]}});
  await f.run('.checkin test a');assert.equal(f.invokes.length,1);assert.deepEqual(f.invokes[0].data,payload);
  await f.run('.checkin');assert.equal(f.requests.length,1);assert.equal(new URL(f.requests[0].url).hostname,'api.telegram.org');assert.deepEqual(f.requests[0].settings.redirects,{allowedHosts:['api.telegram.org'],maxRedirects:0});
});

test('prepared execution resumes after restart, records sent once, and serializes concurrent triggers',async()=>{
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now());
  const f=fixture({state:{schemaVersion:1,runTime:'00:00',randomDelay:0,logChat:'100',botToken:'',pushChatId:'',targets:[{id:'a',name:'A',target:'@a',command:'/sign',enabled:true}],lastRunDate:'',execution:{date,plannedAt:0,status:'prepared'},pending:{},legacyImported:true}});
  await Promise.all([f.job(),f.job()]);assert.equal(f.states.state.lastRunDate,date);assert.equal(f.states.state.execution.status,'sent');assert.equal(f.sent.filter(x=>x.peer==='@a').length,1);assert.equal(f.peak(),1);
});

test('cross-midnight windows keep the start date and ambiguous prepared targets are not resent',async()=>{
  const fixed=Date.parse('2026-09-07T17:00:00Z'),originalNow=Date.now,originalRandom=Math.random;Date.now=()=>fixed;Math.random=()=>0;
  try{
    const f=fixture({state:{schemaVersion:1,runTime:'22:00',runTimeEnd:'02:00',randomDelay:0,logChat:'100',botToken:'',pushChatId:'',targets:[{id:'a',name:'A',target:'@a',command:'/sign',enabled:true}],lastRunDate:'',pending:{},legacyImported:true}});
    await f.job();assert.equal(f.states.state.lastRunDate,'2026-09-07');assert.equal(f.states.state.execution.status,'sent');
    const resumed=fixture({state:{schemaVersion:1,runTime:'22:00',runTimeEnd:'02:00',randomDelay:0,logChat:'100',botToken:'',pushChatId:'',targets:[{id:'a',name:'A',target:'@a',command:'/sign',enabled:true}],lastRunDate:'',execution:{date:'2026-09-07',plannedAt:0,status:'prepared',startedAt:fixed-1000,targets:{a:{status:'prepared'}}},pending:{},legacyImported:true}});
    await resumed.job();assert.equal(resumed.sent.filter(x=>x.peer==='@a').length,0);assert.match(resumed.sent.find(x=>x.peer==='100').value.message,/避免重复发送/);
  }finally{Date.now=originalNow;Math.random=originalRandom;}
});

test('a restart shortly after a completed range catches up the missed daily run',async()=>{
  const fixed=Date.parse('2026-09-07T06:00:00Z'),originalNow=Date.now,originalRandom=Math.random;Date.now=()=>fixed;Math.random=()=>0;
  try{const f=fixture({state:{schemaVersion:1,runTime:'10:00',runTimeEnd:'11:00',randomDelay:0,logChat:'100',botToken:'',pushChatId:'',targets:[{id:'a',name:'A',target:'@a',command:'/sign',enabled:true}],lastRunDate:'',pending:{},legacyImported:true}});await f.job();assert.equal(f.states.state.lastRunDate,'2026-09-07');assert.equal(f.sent.filter(x=>x.peer==='@a').length,1);}finally{Date.now=originalNow;Math.random=originalRandom;}
});

test('partial target failure is reported and does not mark an unavailable Bot push as successful',async()=>{
  const f=fixture({state:{schemaVersion:1,runTime:'10:00',randomDelay:0,logChat:'100',botToken:'bad',pushChatId:'-100',targets:[{id:'a',name:'A',target:'@a',command:'/a',enabled:true},{id:'b',name:'B',target:'@b',command:'/b',enabled:true}],lastRunDate:'',pending:{},legacyImported:true},sendError:{'@b':Object.assign(new Error('private token'),{code:'RPC_FAILED'})},botStatus:500});
  await f.run('.checkin');assert.equal(f.requests.length,1);assert.ok(f.sent.some(x=>x.peer==='100'&&/1 成功 \/ 1 失败/.test(x.value.message)));assert.ok(f.logs.some(x=>x.event==='checkin_bot_push_failed'));assert.doesNotMatch(JSON.stringify(f.logs),/private token/);
});

test('compiled plugin loads, unloads and reloads through the real PluginHost',async t=>{
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'checkin-host-')));const telegram={async edit(){},async reply(){},async invoke(){},async getReply(){},async withClient(fn,signal){return fn({},signal);}};
  const host=new PluginHost({storageRoot:dir,logger:{info(){},error(){}},telegram});t.after(async()=>{await host.shutdown(1000);await fs.rm(dir,{recursive:true,force:true});});
  await host.load(create());assert.equal(host.snapshot().jobs.jobs,1);assert.equal((await host.unload('checkin',1000)).completed,true);assert.equal(host.snapshot().jobs.jobs,0);await host.load(create());assert.equal(host.snapshot().jobs.jobs,1);
});
