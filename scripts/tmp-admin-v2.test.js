'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),fs=require('node:fs/promises');
const core=path.resolve(__dirname,'../../TeleBox-Core');const {PluginHost}=require(path.join(core,'dist/v2/host.js'));const {buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));const create=require(path.join(buildPlugin({id:'tmp_admin',packageRoot:path.resolve(__dirname,'../tmp_admin'),entry:'v2.ts'}).artifactDir,'index.cjs')).default;
function fixture(initial={schemaVersion:1,jobs:{},enabled:true}, initialParticipant, options={}){let data=structuredClone(initial),participant=initialParticipant??{className:'ChannelParticipant',rank:''};const edits=[],replies=[],invokes=[],resources=[];const controller=new AbortController();const client={async getEntity(value){if(options.getEntity)return options.getEntity(value);return String(value)==='7'?{className:'Channel',id:7n}:{className:'User',id:BigInt(String(value)),firstName:'Alice'}},async getInputEntity(value){const id=value.id??BigInt(String(value));return String(id)==='7'?{className:'InputPeerChannel',channelId:id,accessHash:70n}:{className:'InputPeerUser',userId:id,accessHash:420n}},async invoke(request){invokes.push(request);if(options.invoke){const value=await options.invoke(request,controller);if(value!==undefined)return value;}if(request.className==='channels.GetParticipant'||request.constructor?.name==='GetParticipant')return{participant};if(request.className==='channels.EditAdmin'||request.constructor?.name==='EditAdmin'){participant=request.adminRights?.other?{className:'ChannelParticipantAdmin',rank:request.rank,adminRights:request.adminRights}:{className:'ChannelParticipant',rank:''};return{}}},async sendMessage(){}};const signal=controller.signal;const context={signal,log:{info(){},error(){}},telegram:{edit:async(m,text)=>{if(options.edit)return options.edit(m,text);edits.push(text)},reply:async(m,text)=>replies.push(text),getReply:async()=>undefined,withClient:fn=>fn(client,signal)},storage:{json(){return{async read(){return structuredClone(data)},async update(fn){data=await fn(structuredClone(data));return data}}}},tasks:{add(label,cleanup){const item={label,cleanup};resources.push(item);return async()=>{const i=resources.indexOf(item);if(i>=0)resources.splice(i,1);await cleanup()}},run(label,fn){return Promise.resolve(fn(signal))}}};const plugin=create();return{plugin,edits,replies,invokes,resources,controller,data:()=>data,run:args=>plugin.commands.tmp_admin.handle({message:{id:10,chatId:'7',text:'.tmp_admin '+args.join(' '),outgoing:true,raw:{peerId:7n}},args,command:'tmp_admin',prefix:'.'},context),setup:()=>plugin.setup(context),cleanup:()=>plugin.cleanup(context)};}
test('tmp_admin persists a stable string-id expiry job and protects real admins',async()=>{const f=fixture();await f.setup();await f.run(['add','42','10']);assert.equal(Object.keys(f.data().jobs)[0],'7:42');assert.equal(f.data().jobs['7:42'].userId,'42');assert.equal(f.data().jobs['7:42'].channelAccessHash,'70');assert.equal(f.data().jobs['7:42'].userAccessHash,'420');assert.equal(f.resources.length,1);await f.run(['add','42','10']);assert.match(f.edits.at(-1),/已设置/);await f.cleanup();assert.equal(f.resources.length,0);});
test('tmp_admin setting disables mutations',async()=>{const f=fixture({schemaVersion:1,jobs:{},enabled:false});await f.setup();await f.run(['add','42']);assert.equal(f.invokes.length,0);assert.match(f.edits.at(-1),/关闭/);await f.cleanup();});
test('tmp_admin migrates legacy peer records without losing expiry state',async()=>{const legacy={jobs:{old:{chatKey:'7',channel:{channelId:'7',accessHash:'70'},user:{userId:'42',accessHash:'420'},userId:42,userDisplay:'Alice',expiresAt:Date.now()+60_000,retryCount:0}}};const f=fixture(legacy);await f.setup();assert.equal(f.data().schemaVersion,1);assert.equal(f.data().jobs['7:42'].channelAccessHash,'70');assert.equal(f.data().jobs['7:42'].userAccessHash,'420');assert.equal(f.resources.length,1);await f.cleanup();});

test('tmp_admin waits the full forty days and restores peers from persisted access hashes',async t=>{
  const now=Date.now(),period=40*24*60*60*1000;
  t.mock.timers.enable({apis:['Date','setTimeout'],now});
  const f=fixture({schemaVersion:1,enabled:true,jobs:{'7:42':{chatId:'7',userId:'42',display:'Alice',expiresAt:now+period,originalRank:'',retryCount:0,channelAccessHash:'70',userAccessHash:'420'}}},{className:'ChannelParticipantAdmin',rank:'临时管理',adminRights:{other:true}});
  t.after(()=>f.cleanup());await f.setup();
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(2147483647);await flush();assert.equal(f.invokes.length,0);
  t.mock.timers.tick(period-2147483647-1);await flush();assert.equal(f.invokes.length,0);
  t.mock.timers.tick(1);await flush();await flush();
  const edit=f.invokes.find(r=>r.className==='channels.EditAdmin');assert.ok(edit);
  assert.equal(String(edit.channel.accessHash),'70');assert.equal(String(edit.userId.accessHash),'420');
  assert.deepEqual(f.data().jobs,{});
});

test('tmp_admin cancellation after EditAdmin persists the compensating expiry job and sends no receipt',async()=>{
  const f=fixture(undefined,undefined,{invoke:async(request,controller)=>{if(request.className==='channels.EditAdmin'||request.constructor?.name==='EditAdmin')controller.abort();}});await f.setup();
  await assert.rejects(f.run(['add','42','10']),{name:'AbortError'});assert.ok(f.data().jobs['7:42']);assert.equal(f.resources.length,1);assert.equal(f.edits.length,0);await f.cleanup();
});

test('tmp_admin keeps numeric participant lookup exact and hides native failures',async()=>{
  const wanted='9007199254740993123';
  const f=fixture(undefined,undefined,{getEntity:async value=>{if(String(value)==='7')return{className:'Channel',id:7n};throw new Error('native entity secret');},invoke:async request=>{if(request.className==='channels.GetParticipants'||request.constructor?.name==='GetParticipants')return{participants:[{userId:returnBig(wanted)}],users:[{className:'User',id:returnBig(wanted),firstName:'Exact'}]};}});
  function returnBig(value){return require(path.join(core,'node_modules/teleproto/Helpers')).returnBigInt(value);}
  await f.setup();const promise=f.run(['add',wanted,'1']);await new Promise(resolve=>setTimeout(resolve,1250));await promise;assert.ok(f.data().jobs[`7:${wanted}`]);await f.cleanup();
  const broken=fixture(undefined,undefined,{getEntity:async value=>{if(String(value)==='7')return{className:'Channel',id:7n};throw new Error('native entity secret');},invoke:async request=>{if(request.className==='channels.GetParticipants'||request.constructor?.name==='GetParticipants')throw new Error('RPC_TOKEN_SECRET');}});await broken.setup();await broken.run(['add','42']);assert.doesNotMatch(broken.edits.at(-1),/TOKEN|secret/i);assert.match(broken.edits.at(-1),/稍后重试/);await broken.cleanup();
});

test('tmp_admin lists every persisted job through SDK pagination',async()=>{
  const jobs={};for(let index=0;index<220;index++)jobs[`7:${index}`]={chatId:'7',userId:String(index),display:`User ${index} ${'x'.repeat(30)}`,expiresAt:Date.now()+60000,originalRank:'',retryCount:0};
  const f=fixture({schemaVersion:1,jobs,enabled:true});await f.setup();await f.run(['ls']);const output=[...f.edits,...f.replies].join('\n');assert.ok(f.replies.length>0);assert.match(output,/User 0 /);assert.match(output,/User 219 /);await f.cleanup();
});

test('tmp_admin PluginHost unload after a successful grant leaves a restart-recoverable expiry intent',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'tmp-admin-host-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));let releaseGrant,grantStarted;const started=new Promise(resolve=>grantStarted=resolve),release=new Promise(resolve=>releaseGrant=resolve);const edits=[];
  const native={async getEntity(value){return String(value)==='7'?{className:'Channel',id:7n}:{className:'User',id:42n,firstName:'Alice'};},async getInputEntity(value){const id=value.id??BigInt(String(value));return String(id)==='7'?{className:'InputPeerChannel',channelId:id,accessHash:70n}:{className:'InputPeerUser',userId:id,accessHash:420n};},async invoke(request){if(request.className==='channels.GetParticipant'||request.constructor?.name==='GetParticipant')return{participant:{className:'ChannelParticipant'}};if(request.className==='channels.EditAdmin'||request.constructor?.name==='EditAdmin'){grantStarted();await release;return{};}},async sendMessage(){}};
  const telegram={async edit(_m,text){edits.push(text);},async reply(){},async invoke(){},async getReply(){},async withClient(operation,signal){return operation(native,signal);}};const logger={info(){},error(){}};
  const host=new PluginHost({storageRoot:root,telegram,logger});await host.load(create());const dispatch=host.dispatchPrimary({id:10,chatId:'7',senderId:'1',outgoing:true,text:'.tmp_admin add 42 0.0001',raw:{peerId:7n}});await started;const unloading=host.unload('tmp_admin');releaseGrant();await Promise.allSettled([dispatch,unloading]);
  const saved=JSON.parse(await fs.readFile(path.join(root,'tmp_admin','jobs.json'),'utf8'));assert.ok(saved.jobs['7:42']);assert.equal(edits.length,0);
  let revoked=false;const recoveryNative={...native,async invoke(request){if(request.className==='channels.GetParticipant'||request.constructor?.name==='GetParticipant')return{participant:{className:'ChannelParticipantAdmin',rank:'临时管理',adminRights:{other:true}}};if(request.className==='channels.EditAdmin'||request.constructor?.name==='EditAdmin'){revoked=!request.adminRights.other;return{};}},async sendMessage(){}};const recovery=new PluginHost({storageRoot:root,logger,telegram:{...telegram,async withClient(operation,signal){return operation(recoveryNative,signal);}}});await recovery.load(create());for(let i=0;i<20&&!revoked;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(revoked,true);await recovery.shutdown(1000);
});

test('tmp_admin rejects an unsafe deadline before granting and does not trust error prefixes',async()=>{
  const f=fixture();await f.setup();await f.run(['add','42','1e308']);assert.equal(f.invokes.filter(request=>request.className==='channels.EditAdmin'||request.constructor?.name==='EditAdmin').length,0);assert.match(f.edits.at(-1),/安全保存/);await f.cleanup();
  const spoof=fixture(undefined,undefined,{getEntity:async value=>{if(String(value)==='7')return{className:'Channel',id:7n};throw new Error('时长必须 sk-live-secret');}});await spoof.setup();await spoof.run(['add','name']);assert.doesNotMatch(spoof.edits.at(-1),/sk-live|secret/);await spoof.cleanup();
});

test('tmp_admin receipt failure does not report a successful grant as failed',async()=>{
  const f=fixture(undefined,undefined,{edit:async()=>{throw new Error('receipt transport secret')}});await f.setup();await f.run(['add','42','1']);assert.ok(f.invokes.some(request=>(request.className==='channels.EditAdmin'||request.constructor?.name==='EditAdmin')&&request.adminRights.other));assert.ok(f.data().jobs['7:42']);assert.equal(f.edits.length,0);await f.cleanup();
});

test('tmp_admin expiry waits for an in-flight grant that crosses its deadline',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date','setTimeout'],now});let releaseGrant,started;const gate=new Promise(resolve=>releaseGrant=resolve),grantStarted=new Promise(resolve=>started=resolve),first=true;
  const f=fixture(undefined,undefined,{invoke:async request=>{if((request.className==='channels.EditAdmin'||request.constructor?.name==='EditAdmin')&&request.adminRights.other&&first){started();await gate;return undefined;}}});t.after(()=>f.cleanup());await f.setup();const adding=f.run(['add','42','0.0001']);await grantStarted;t.mock.timers.tick(10);await new Promise(resolve=>setImmediate(resolve));releaseGrant();await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(1200);await adding;for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  const edits=f.invokes.filter(request=>request.className==='channels.EditAdmin'||request.constructor?.name==='EditAdmin');assert.equal(edits.length,2);assert.equal(edits[0].adminRights.other,true);assert.equal(Boolean(edits[1].adminRights.other),false);assert.deepEqual(f.data().jobs,{});
});

test('tmp_admin renewal waits for a stale expiry lookup and becomes the final generation',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date','setTimeout'],now});let releaseLookup,lookupStarted,blocked=true;const gate=new Promise(resolve=>releaseLookup=resolve),started=new Promise(resolve=>lookupStarted=resolve);
  const initial={schemaVersion:1,enabled:true,jobs:{'7:42':{chatId:'7',userId:'42',display:'Alice',expiresAt:now,originalRank:'',retryCount:0,channelAccessHash:'70',userAccessHash:'420'}}};
  const f=fixture(initial,{className:'ChannelParticipantAdmin',rank:'临时管理',adminRights:{other:true}},{invoke:async request=>{if((request.className==='channels.GetParticipant'||request.constructor?.name==='GetParticipant')&&blocked){blocked=false;lookupStarted();await gate;return undefined;}}});t.after(()=>f.cleanup());await f.setup();t.mock.timers.tick(0);await started;
  let renewed=false;const renewal=f.run(['add','42','10']).then(()=>{renewed=true});await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(1200);await new Promise(resolve=>setImmediate(resolve));assert.equal(renewed,false);releaseLookup();for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(1200);await renewal;for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.data().jobs['7:42']);assert.ok(f.data().jobs['7:42'].expiresAt>now);const edits=f.invokes.filter(request=>request.className==='channels.EditAdmin'||request.constructor?.name==='EditAdmin');assert.equal(edits.length,2);assert.equal(Boolean(edits[0].adminRights.other),false);assert.equal(edits[1].adminRights.other,true);
});

test('tmp_admin renewal waits for an old demotion RPC and then remains the active generation',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date','setTimeout'],now});let releaseDemote,demoteStarted,block=true;const gate=new Promise(resolve=>releaseDemote=resolve),started=new Promise(resolve=>demoteStarted=resolve);
  const initial={schemaVersion:1,enabled:true,jobs:{'7:42':{chatId:'7',userId:'42',display:'Alice',expiresAt:now,originalRank:'',retryCount:0,channelAccessHash:'70',userAccessHash:'420'}}};
  const f=fixture(initial,{className:'ChannelParticipantAdmin',rank:'临时管理',adminRights:{other:true}},{invoke:async request=>{if((request.className==='channels.EditAdmin'||request.constructor?.name==='EditAdmin')&&!request.adminRights.other&&block){block=false;demoteStarted();await gate;return undefined;}}});t.after(()=>f.cleanup());await f.setup();t.mock.timers.tick(0);await started;
  let renewed=false;const renewal=f.run(['add','42','10']).then(()=>{renewed=true});for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(renewed,false);assert.equal(f.invokes.filter(request=>(request.className==='channels.EditAdmin'||request.constructor?.name==='EditAdmin')&&request.adminRights.other).length,0);
  releaseDemote();for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(1200);await renewal;assert.equal(renewed,true);assert.ok(f.data().jobs['7:42']);assert.ok(f.data().jobs['7:42'].expiresAt>now);const edits=f.invokes.filter(request=>request.className==='channels.EditAdmin'||request.constructor?.name==='EditAdmin');assert.equal(Boolean(edits[0].adminRights.other),false);assert.equal(edits.at(-1).adminRights.other,true);
});
