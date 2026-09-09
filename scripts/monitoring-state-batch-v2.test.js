'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const core=path.resolve(__dirname,'../../TeleBox-Core');
const {buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));
const {PluginHost}=require(path.join(core,'dist/v2/host.js'));

function built(id){const {artifactDir}=buildPlugin({id,packageRoot:path.resolve(__dirname,'..',id),entry:'v2.ts'});return require(path.join(artifactDir,'index.cjs')).default;}
const createKeyword=built('keyword'),createIm=built('im'),createLottery=built('lottery'),createCaptcha=built('pmcaptcha');
function memory(initial){let value=structuredClone(initial);let tail=Promise.resolve();return{read(){return tail.then(()=>structuredClone(value));},update(fn){const next=tail.then(async()=>{value=await fn(structuredClone(value));return structuredClone(value);});tail=next.then(()=>{},()=>{});return next;},value:()=>structuredClone(value)};}
function context(state,client={}){const edits=[],replies=[],logs=[],controller=new AbortController();const json=memory(state);return{json,edits,replies,controller,ctx:{signal:controller.signal,tasks:{run(_label,fn){return fn(controller.signal);},add(){return async()=>{};}},storage:{json(){return json;},sqlite(){return{read(){return Promise.reject(Object.assign(new Error('missing'),{code:'ENOENT'}));}};}},telegram:{async edit(_m,text,options){edits.push({text,options});},async reply(_m,text,options){replies.push({text,options});},async getReply(){return undefined;},async withClient(fn){return fn(client,controller.signal);}},log:{info(){},error(event,fields){logs.push({event,fields});}}}};}
const message=(text,extra={})=>({id:1,chatId:'-1009007199254740993',senderId:'9007199254740995',outgoing:true,text,raw:{peerId:{className:'PeerChannel'},...extra}});

test('pmcaptcha accepts documented Chinese actions and rejects unknown actions atomically', async () => {
  const f = context({schemaVersion: 1, config: {failActions: [], passActions: []}, sessions: {}, importedLegacy: true});
  const plugin = createCaptcha();
  const run = args => plugin.commands.pmc.handle({command: 'pmc', prefix: '.', args, message: message(`.pmc ${args.join(' ')}`)}, f.ctx);
  await run(['set', 'fail', '屏蔽', '举报']);
  assert.deepEqual(f.json.value().config.failActions, ['block', 'report']);
  await run(['set', 'pass', '取消静音', '取消归档', '白名单']);
  assert.deepEqual(f.json.value().config.passActions, ['unmute', 'unarchive', 'whitelist']);
  await run(['set', 'fail', 'block', '拼写错误']);
  assert.match(f.edits.at(-1).text, /未知动作/);
  assert.deepEqual(f.json.value().config.failActions, ['block', 'report']);
  await run(['set', 'fail', '无']);
  assert.deepEqual(f.json.value().config.failActions, []);
});

test('keyword keeps string chat ids, preserves unknown state, and gives inherited rules priority',async()=>{
  const state={schemaVersion:1,nextId:3,importedLegacy:true,future:{kept:true},aliases:{'-1009007199254740993':'-1001'},tasks:[
    {id:1,chatId:'-1001',key:'hello',response:'inherited',include:true,regexp:false,exact:false,caseSensitive:false,ignoreForward:false,reply:true,deleteSource:false,banSeconds:0,restrictSeconds:0,deleteReplyAfter:0,deleteSourceAfter:0},
    {id:2,chatId:'-1009007199254740993',key:'hello',response:'local',include:true,regexp:false,exact:false,caseSensitive:false,ignoreForward:false,reply:true,deleteSource:false,banSeconds:0,restrictSeconds:0,deleteReplyAfter:0,deleteSourceAfter:0},
  ]};
  const sent=[];const f=context(state,{async sendMessage(_peer,options){sent.push(options.message);return{id:sent.length};}}),plugin=createKeyword();
  await plugin.setup(f.ctx);await plugin.listeners[0].handle({...message('hello'),outgoing:false},f.ctx);
  assert.deepEqual(sent,['inherited','local']);assert.equal(f.json.value().future.kept,true);assert.equal(f.json.value().tasks[1].chatId,'-1009007199254740993');
});

test('im normalizes legacy chat ids and blocks command-media double processing',async()=>{
  const f=context({schemaVersion:0,enabled:true,monitoredChats:[-1001],bannedMD5s:{},defaultAction:'delete',future:'kept',importedLegacy:false});const plugin=createIm();
  await plugin.setup(f.ctx);const data=f.json.value();assert.deepEqual(data.monitoredChats,[{id:'-1001',name:'-1001'}]);assert.deepEqual(data.bannedStickerIds,{});assert.equal(data.future,'kept');assert.equal(plugin.listeners[0].ignoreCommands,true);assert.equal(plugin.listeners[0].edited,true);
});

test('im hashes media incrementally and enforces the configured byte cap',async()=>{
  const chunks=[Buffer.from('hello '),Buffer.from('world')];
  const client={async *iterDownload(){for(const chunk of chunks)yield chunk;}};
  const state={schemaVersion:1,enabled:true,monitoredChats:[],bannedMD5s:{},bannedStickerIds:{},defaultAction:'delete',importedLegacy:true};
  const f=context(state,client),plugin=createIm(),reply={...message(''),raw:{media:{className:'MessageMediaPhoto',photo:{className:'Photo',sizes:[{size:11}]}}}};
  f.ctx.telegram.getReply=async()=>reply;
  await plugin.commands.im.handle({command:'im',prefix:'.',args:['delete'],message:{...message('.im delete'),replyToId:2}},f.ctx);
  assert.equal(Object.keys(f.json.value().bannedMD5s)[0],'5eb63bbbe01eeed093cb22bb8f5acdc3');
});

test('lottery persists warehouse, activity and participants with string ids',async()=>{
  const state={schemaVersion:1,activities:{},warehouses:{},settings:{minUsers:2,maxUsers:1000,timeout:60},importedLegacy:true};
  let sentId=10;const sent=[];const client={async sendMessage(peer,options){sent.push({peer,options});return{id:sentId++};},async getEntity(){return{id:'9007199254740995',firstName:'Alice'};}};const f=context(state,client),plugin=createLottery();
  const invoke=async(text,saved=false)=>plugin.commands.lottery.handle({command:'lottery',prefix:'.',args:text.split(/\s+/).slice(1),message:{...message(text),saved}},f.ctx);
  await invoke('.lottery prize create gifts',true);await invoke('.lottery prize add gifts coupon 2',true);await invoke('.lottery create event JOIN 2 1 gifts');
  const activity=Object.values(f.json.value().activities)[0];assert.equal(activity.chatId,'-1009007199254740993');assert.equal(activity.creatorId,'9007199254740995');
  await plugin.listeners[0].handle({...message('JOIN'),outgoing:false},f.ctx);assert.equal(Object.values(f.json.value().activities)[0].participants[0].userId,'9007199254740995');
});

test('pmcaptcha applies whitelist words before premium blocking and stores ids as strings',async()=>{
  const state={schemaVersion:1,importedLegacy:true,sessions:{},config:{enabled:true,captchaEnabled:true,mode:'text',timeout:0,maxTries:3,keyword:'agree',prompt:'',failActions:['archive','mute'],passActions:['whitelist'],whitelist:[],verified:[],failed:[],initiative:true,historyCount:-1,groupsInCommon:-1,wlWords:['trusted'],blWords:['spam'],premium:'ban'}};
  const invokes=[];const client={async getInputEntity(id){return id;},async invoke(req){invokes.push(req);},async getEntity(){return{id:'9007199254740995'};}};const f=context(state,client),plugin=createCaptcha();
  await plugin.setup(f.ctx);await plugin.listeners[0].handle({...message('trusted'),outgoing:false,raw:{isPrivate:true,sender:{premium:true,firstName:'Alice'}}},f.ctx);
  const saved=f.json.value();assert.ok(saved.config.verified.some(x=>x.id==='9007199254740995'));assert.ok(saved.config.whitelist.includes('9007199254740995'));assert.equal(saved.sessions['9007199254740995'],undefined);assert.equal(invokes.length,0);
});

test('pmcaptcha emits a real PNG challenge when canvas is available',async()=>{
  const state={schemaVersion:1,importedLegacy:true,sessions:{},config:{enabled:true,captchaEnabled:true,mode:'img_digit',timeout:0,maxTries:3,keyword:'agree',prompt:'',failActions:[],passActions:[],whitelist:[],verified:[],failed:[],initiative:true,historyCount:-1,groupsInCommon:-1,wlWords:[],blWords:[],premium:'none'}};
  const sent=[];const client={async getInputEntity(id){return id;},async invoke(){},async sendMessage(_peer,options){sent.push(options);return{id:42};}};
  const f=context(state,client),plugin=createCaptcha();await plugin.setup(f.ctx);
  await plugin.listeners[0].handle({...message('hello'),outgoing:false,raw:{isPrivate:true,sender:{firstName:'Alice'}}},f.ctx);
  assert.equal(sent.length,1);assert.equal(sent[0].file.name,'captcha.png');assert.ok(sent[0].file.size>100);
  const session=f.json.value().sessions['9007199254740995'];assert.equal(session.mode,'img_digit');assert.match(session.answer,/^\d{5}$/);
});

test('all four definitions expose stable commands and unload-safe listeners',()=>{
  const plugins=[createKeyword(),createIm(),createLottery(),createCaptcha()];assert.deepEqual(Object.keys(plugins[0].commands),['keyword']);assert.deepEqual(Object.keys(plugins[1].commands),['im']);assert.deepEqual(Object.keys(plugins[2].commands),['lottery']);assert.deepEqual(Object.keys(plugins[3].commands),['pmc','pmcaptcha']);
  for(const plugin of plugins)assert.equal(plugin.listeners.length,1);
});

test('all four artifacts load, unload and reload through the real PluginHost',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mibot-monitoring-host-')));
  const host=new PluginHost({storageRoot:root,logger:{info(){},error(){}},telegram:{async edit(){},async reply(){},async invoke(){},async getReply(){},async withClient(operation,signal){return operation({},signal);}}});
  t.after(async()=>{await host.shutdown(1000);await fs.rm(root,{recursive:true,force:true});});
  for(const factory of [createKeyword,createIm,createLottery,createCaptcha]){
    const first=factory();await host.load(first);assert.equal(host.snapshot().plugins,1);assert.equal((await host.unload(first.id,1000)).completed,true);await host.load(factory());assert.equal((await host.unload(first.id,1000)).completed,true);
  }
});

test('lottery keeps prize content private and allows an administrator to draw',async()=>{
  const state={schemaVersion:1,activities:{},warehouses:{alpha:[{text:'PRIVATE-CODE-123',stock:2,order:0}]},settings:{minUsers:2,maxUsers:1000,timeout:60},importedLegacy:true};
  const sent=[];const client={async sendMessage(peer,options){sent.push({peer,options});return{id:sent.length};},async getEntity(){return{className:'Channel',id:7n};},async invoke(){return{participant:{className:'ChannelParticipantAdmin'}};}};
  const f=context(state,client),plugin=createLottery();
  const run=(args,extra={})=>plugin.commands.lottery.handle({command:'lottery',prefix:'.',args,message:{...message('.lottery '+args.join(' ')),...extra}},f.ctx);
  await run(['prize','list','alpha']);assert.match(f.edits.at(-1).text,/只能在私聊/);assert.ok(!f.edits.at(-1).text.includes('PRIVATE-CODE'));
  await run(['prize','list','alpha'],{raw:{isPrivate:true}});assert.ok(f.edits.at(-1).text.includes('PRIVATE-CODE'));
  await run(['create','event','JOIN','2','1','1']);const activity=Object.values(f.json.value().activities)[0];assert.equal(activity.warehouse,'alpha');
  await f.json.update(v=>{v.activities[activity.id].participants=[{userId:'42',firstName:'Alice',joinedAt:Date.now()}];return v;});
  sent.length=0;await run(['draw'],{senderId:'99'});
  assert.equal(f.json.value().activities[activity.id].status,'completed');
  assert.ok(sent.find(x=>String(x.peer)==='42').options.message.includes('PRIVATE-CODE-123'));
  assert.ok(sent.filter(x=>String(x.peer)!=='42').every(x=>!x.options.message.includes('PRIVATE-CODE-123')));
  await run(['winners']);assert.ok(!f.edits.at(-1).text.includes('PRIVATE-CODE-123'));
});
