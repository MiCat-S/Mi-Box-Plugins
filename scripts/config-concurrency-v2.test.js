'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{getEventListeners}=require('node:events');
const test=require('node:test'),os=require('node:os');
const root=os.tmpdir(),core=path.resolve(__dirname,'../../TeleBox-Core'),plugins=path.resolve(__dirname,'..');
const {buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));
const {PluginHost}=require(path.join(core,'dist/v2/host.js'));
const {prepareArtifact}=require(path.join(core,'dist/v2/artifacts.js'));
const {buildSync}=require(path.join(core,'node_modules/esbuild'));
const {Api,utils}=require(path.join(core,'node_modules/teleproto'));
const {returnBigInt:integer}=require(path.join(core,'node_modules/teleproto/Helpers.js'));
async function artifact(id){return prepareArtifact(buildPlugin({id,packageRoot:path.join(plugins,id),entry:'v2.ts'}).artifactDir);}
async function fixture(id,native,prefixes=["."]){const a=await artifact(id),data=await fs.realpath(await fs.mkdtemp(path.join(root,'state-'))),edits=[];const fail=async()=>{throw new Error('unexpected external operation');};const host=new PluginHost({prefixes,storageRoot:path.join(data,'assets'),tempRoot:path.join(data,'temp'),logger:{info(){},error(){}},telegram:{edit:async(m,t)=>edits.push(t),reply:fail,invoke:fail,getReply:async()=>undefined,withClient:(fn,s)=>fn(native,s)}});await host.load(a.create());return{a,data,host,edits,close:async()=>{assert.equal((await host.shutdown(2000)).completed,true);a.release();await fs.rm(data,{recursive:true,force:true});}};}
test('acron creates distinct jobs concurrently and preserves marked channel targets',async()=>{
 const channel=new Api.Channel({id:integer(10),accessHash:integer(44),title:'Group',megagroup:true,photo:new Api.ChatPhotoEmpty(),date:0});
 let arrivals=0,release;const gate=new Promise(r=>release=r);
 const f=await fixture('acron',{getEntity:async()=>{if(++arrivals===2)release();await gate;return channel;}});
 try{const text='.acron cmd 0 0 0 1 1 * @group\n.ping';await Promise.all(['100','200'].map(chatId=>f.host.dispatchPrimary({id:1,chatId,senderId:'1',outgoing:true,text})));
  const state=JSON.parse(await fs.readFile(path.join(f.data,'assets/acron/acron_config.json')));
  assert.deepEqual(state.tasks.map(x=>x.id).sort(),['1','2']);assert.equal(state.seq,'2');
  assert.ok(state.tasks.every(x=>x.chatId===utils.getPeerId(channel)));
  assert.equal(f.host.snapshot().jobs.jobs,2);
  await f.host.dispatchPrimary({id:2,chatId:utils.getPeerId(channel),senderId:'1',outgoing:true,text:'.acron ls'});
  assert.match(f.edits.at(-1),/2 个/);
 }finally{await f.close();}
});
test('cy concurrent time and target updates preserve both fields',async()=>{
 const f=await fixture('cy',{});try{
  await Promise.all([['100','.cy target @newtarget'],['200','.cy time 09:00']].map(([chatId,text])=>f.host.dispatchPrimary({id:1,chatId,senderId:'1',outgoing:true,text})));
  const state=JSON.parse(await fs.readFile(path.join(f.data,'assets/cy/schedule.json')));assert.equal(state.target,'@newtarget');assert.deepEqual(state.times,['09:00']);
 }finally{await f.close();}
});
test('uai concurrent prompt mutations preserve independently updated entries',async()=>{
 const f=await fixture('uai',{});try{
  const run=(chatId,text)=>f.host.dispatchPrimary({id:1,chatId,senderId:'1',outgoing:true,text});
  await Promise.all(['first','second'].map((name,i)=>run(String(i+100),'.uai prompt add '+name+' instruction')));
  let state=JSON.parse(await fs.readFile(path.join(f.data,'assets/uai/v2-config.json')));assert.deepEqual(Object.keys(state.prompts).sort(),['first','second']);
  await Promise.all([run('100','.uai prompt del first'),run('200','.uai prompt add third instruction')]);
  state=JSON.parse(await fs.readFile(path.join(f.data,'assets/uai/v2-config.json')));assert.deepEqual(Object.keys(state.prompts).sort(),['second','third']);
 }finally{await f.close();}
});
test('sure accepts marked chat IDs and uses the persisted whitelist for relay',async()=>{
 const sent=[],f=await fixture('sure',{getMe:async()=>({id:integer(1)}),sendMessage:async(peer,value)=>sent.push({peer,value})});try{
  for(const text of ['.sure chat add -10010','.sure chat add -22','.sure user add 2','.sure msg add hello'])await f.host.dispatchPrimary({id:1,chatId:'1',senderId:'1',outgoing:true,text});
  const state=JSON.parse(await fs.readFile(path.join(f.data,'assets/sure/config.json')));assert.deepEqual(state.chats,['-10010','-22']);
  for(const chatId of ['-10010','-22','-99'])await f.host.dispatchListeners({id:2,chatId,senderId:'2',outgoing:false,text:'hello',raw:{peerId:chatId}});
  assert.deepEqual(sent.map(x=>x.peer),['-10010','-22']);
  await f.host.dispatchPrimary({id:3,chatId:'1',senderId:'1',outgoing:true,text:'.sure user add -2'});assert.match(f.edits.at(-1),/用法/);
 }finally{await f.close();}
});
test('re usage follows the configured command prefix',async()=>{
 const f=await fixture('re',{},['!']);try{await f.host.dispatchPrimary({id:1,chatId:'1',senderId:'1',outgoing:true,text:'!re'});assert.match(f.edits.at(-1),/使用 !re/);}finally{await f.close();}
});

test('acron registration failure preserves the sequence allocated to concurrent jobs',async()=>{
 const f=await fixture('acron',{getEntity:async()=>new Api.User({id:integer(1),firstName:'Owner'})});try{
  const run=(chatId,cron)=>f.host.dispatchPrimary({id:1,chatId,senderId:'1',outgoing:true,text:'.acron cmd '+cron+' me\n.ping'});
  await Promise.all([run('100','0 99 0 1 1 *'),run('200','0 0 0 1 1 *')]);
  await run('300','0 0 0 1 1 *');
  const state=JSON.parse(await fs.readFile(path.join(f.data,'assets/acron/acron_config.json')));
  assert.equal(state.seq,'3');assert.equal(state.tasks.length,2);assert.equal(new Set(state.tasks.map(x=>x.id)).size,2);assert.equal(f.host.snapshot().jobs.jobs,2);
 }finally{await f.close();}
});

test('acron resolves legacy unmarked channel IDs from the original target before sending',async()=>{
 const built=buildPlugin({id:'acron',packageRoot:path.join(plugins,'acron'),entry:'v2.ts'}),plugin=require(path.join(built.artifactDir,'index.cjs')).default();
 const channel=new Api.Channel({id:integer(10),accessHash:integer(44),title:'Group',megagroup:true,photo:new Api.ChatPhotoEmpty(),date:0});
 let state={schemaVersion:1,seq:'1',tasks:[{id:'1',type:'send',cron:'0 0 0 1 1 *',chat:'@group',chatId:'10',message:'scheduled'}]},job;const resolved=[],sent=[];
 const context={storage:{json:()=>({read:async()=>structuredClone(state),update:async fn=>{state=fn(structuredClone(state));return structuredClone(state);}})},jobs:{register:async(_name,_spec,fn)=>{job=fn;return async()=>{};}},telegram:{withClient:fn=>fn({getEntity:async value=>{resolved.push(value);return channel;},sendMessage:async(peer,value)=>sent.push({peer,value})})}};
 try{await plugin.setup(context);await job();assert.deepEqual(resolved,['@group']);assert.equal(utils.getPeerId(sent[0].peer),'-10010');assert.equal(state.tasks[0].chatId,'-10010');assert.equal(state.tasks[0].resolvedPeer,true);
  await job();assert.equal(resolved.length,1);assert.equal(sent[1].peer.toString(),'-10010');
 }finally{await plugin.cleanup();}
});

test('uai concurrent prompt and display edits preserve each other',async()=>{
 const f=await fixture('uai',{});try{
  const run=(chatId,text)=>f.host.dispatchPrimary({id:1,chatId,senderId:'1',outgoing:true,text});
  await Promise.all([run('100','.uai prompt add note prompt'),run('200','.uai collapse off')]);
  let state=JSON.parse(await fs.readFile(path.join(f.data,'assets/uai/v2-config.json')));assert.equal(state.prompts.note,'prompt');assert.equal(state.collapse,false);
  await Promise.all([run('100','.uai prompt add second instruction'),run('200','.uai collapse on')]);
  state=JSON.parse(await fs.readFile(path.join(f.data,'assets/uai/v2-config.json')));assert.deepEqual(Object.keys(state.prompts).sort(),['note','second']);assert.equal(state.collapse,true);
 }finally{await f.close();}
});
