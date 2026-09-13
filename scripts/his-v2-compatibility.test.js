'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const core=path.resolve(__dirname,'../../TeleBox-Core');
const {buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));
const {PluginHost}=require(path.join(core,'dist/v2/host.js'));
const create=require(path.join(buildPlugin({id:'his',packageRoot:path.resolve(__dirname,'../his'),entry:'v2.ts'}).artifactDir,'index.cjs')).default;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

async function fixture(t,options={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'his-compat-'))),edits=[],replies=[],logs=[];
  let editCalls=0,replyCalls=0;
  const client=options.client||{async getEntity(value){return String(value)==='7'?{id:7n,title:'Group',megagroup:true}:{firstName:'Alice'};},async *iterMessages(){yield{id:3,text:'hello'};}};
  const host=new PluginHost({storageRoot:root,logger:{info(event,fields){logs.push({event,fields});},error(){}},telegram:{
    async edit(_message,text,settings){editCalls++;if(editCalls===options.failEditAt)throw new Error('edit failed token=private-secret /private/path');edits.push({text,settings});},async reply(_message,text,settings){replyCalls++;if(replyCalls===options.failReplyAt)throw new Error('reply failed');replies.push({text,settings});},async invoke(){},
    async getReply(){if(options.getReplyFailure)throw new Error('reply token=private-secret /private/path');return options.reply??{senderId:'42'};},async withClient(operation,signal){return operation(client,signal);},
  }});
  await host.load(create());
  t.after(async()=>{await host.shutdown(1000);await fs.rm(root,{recursive:true,force:true});});
  const run=(text='.his 9007199254741999 1')=>host.dispatchPrimary({id:1,chatId:'7',senderId:'1',outgoing:true,chatType:'supergroup',text,replyToId:2,raw:{peerId:'7'}});
  return{host,client,edits,replies,logs,run};
}

test('HIS-COMPAT-01 numeric targets retain precision in the Teleproto boundary',async t=>{
  let target;
  const client={async getEntity(value){return String(value)==='7'?{id:7n,title:'Group',megagroup:true}:{firstName:'Alice'};},async *iterMessages(_chat,options){target=options.fromUser;yield{id:1,text:'ok'};}};
  const f=await fixture(t,{client});
  await f.run();
  assert.equal(String(target),'9007199254741999');
  assert.equal(typeof target,'object');
  assert.equal(typeof target.add,'function');
});

test('HIS-COMPAT-02 cancellation while resolving display entity prevents later native work and feedback',async t=>{
  const entered=deferred(),release=deferred();let entities=0,iterations=0;
  const client={async getEntity(){entities++;entered.resolve();await release.promise;return{firstName:'Alice'};},async *iterMessages(){iterations++;yield{id:1,text:'must not run'};}};
  const f=await fixture(t,{client});
  const running=f.run('.his @alice 1');
  await entered.promise;
  const unloading=f.host.unload('his',1000);
  release.resolve();
  assert.equal((await unloading).completed,true);
  await running;
  assert.equal(entities,1);
  assert.equal(iterations,0);
  assert.deepEqual(f.edits.map(item=>item.text),['🔍 正在查询消息历史...']);
});

test('HIS-COMPAT-03 later page failure preserves the published result and reports interruption',async t=>{
  const client={async getEntity(value){return String(value)==='7'?{id:7n,title:'Group',megagroup:true}:{firstName:'Alice'};},async *iterMessages(){for(let id=1;id<=100;id++)yield{id,text:'&'.repeat(50)};}};
  const f=await fixture(t,{client,failReplyAt:1});
  await f.run('.his @alice 100');
  assert.match(f.edits.at(-1).text,/消息历史查询/);
  assert.doesNotMatch(f.edits.at(-1).text,/操作失败/);
  assert.match(f.replies.at(-1).text,/已发送 1\/\d+ 页，后续页发送中断/);
  assert.equal(f.logs.at(-1).event,'pagination_delivery_interrupted');
});

test('HIS-COMPAT-04 reply/count argument matrix keeps defaults, cap, and validation',async t=>{
  const calls=[];
  const client={async getEntity(value){return String(value)==='7'?{id:7n,title:'Group',megagroup:true}:{firstName:'Alice'};},async *iterMessages(chat,options){calls.push({chat,options});yield{id:1,text:'ok'};}};
  for(const [command,expectedTarget,expectedLimit] of [['.his','42',30],['.his 999','42',100],['.his @alice','@alice',30],['.his @alice 7','@alice',7]]){
    const f=await fixture(t,{client});await f.run(command);const call=calls.at(-1);assert.equal(String(call.options.fromUser),expectedTarget);assert.equal(call.options.limit,expectedLimit);
  }
  const invalid=await fixture(t,{client});await invalid.run('.his @alice 0');assert.equal(invalid.edits.at(-1).text,'❌ 无效的数量参数');
  const excessive=await fixture(t,{client});await excessive.run('.his a 1 extra');assert.match(excessive.edits.at(-1).text,/参数过多/);
});

test('HIS-COMPAT-05 media and service message matrix is labeled and escaped',async t=>{
  const document=attributes=>({className:'MessageMediaDocument',document:{attributes}});
  const items=[
    {media:{className:'MessageMediaPhoto'},label:'图片'},
    {media:document([{className:'DocumentAttributeSticker'}]),label:'贴纸'},
    {media:document([{className:'DocumentAttributeAnimated'}]),label:'动画'},
    {media:document([{className:'DocumentAttributeVideo'}]),label:'视频'},
    {media:document([{className:'DocumentAttributeAudio',voice:true}]),label:'语音'},
    {media:document([{className:'DocumentAttributeAudio'}]),label:'音频'},
    {media:document([]),label:'文档'},
    ...[['MessageMediaContact','联系人'],['MessageMediaGeo','位置'],['MessageMediaVenue','地点'],['MessageMediaPoll','投票'],['MessageMediaWebPage','网页'],['MessageMediaDice','骰子'],['MessageMediaGame','游戏']].map(([className,label])=>({media:{className},label})),
  ];
  const client={async getEntity(value){return String(value)==='7'?{username:'group'}:{firstName:'Alice<&'};},async *iterMessages(){let id=0;for(const item of items)yield{id:++id,text:'<&',media:item.media};yield{id:++id,className:'MessageService',action:{className:'MessageActionChatEditTitle',title:'New<&'}};}};
  const f=await fixture(t,{client});await f.run('.his @alice 100');const output=[...f.edits,...f.replies].map(item=>item.text).join('\n');
  for(const item of items)assert.match(output,new RegExp(`\\[${item.label}\\]`));
  assert.match(output,/\[修改群名\] New&lt;&amp;/);assert.match(output,/Alice&lt;&amp;/);assert.doesNotMatch(output,/<&/);
});

test('HIS-COMPAT-06 empty, flood, long-message, and private errors keep dedicated safe feedback',async t=>{
  const empty=await fixture(t,{client:{async getEntity(){return{};},async *iterMessages(){}}});await empty.run('.his @none');assert.match(empty.edits.at(-1).text,/未找到/);
  const flood=await fixture(t,{client:{async getEntity(){return{};},async *iterMessages(){throw new Error('FLOOD_WAIT_37 private');}}});await flood.run('.his @flood');assert.match(flood.edits.at(-1).text,/等待 37 秒/);assert.doesNotMatch(flood.edits.at(-1).text,/private/);
  const long=await fixture(t,{client:{async getEntity(){return{};},async *iterMessages(){throw new Error('MESSAGE_TOO_LONG secret');}}});await long.run('.his @long');assert.match(long.edits.at(-1).text,/消息过长/);assert.doesNotMatch(long.edits.at(-1).text,/secret/);
  const safe=await fixture(t,{client:{async getEntity(){return{};},async *iterMessages(){throw new Error('<secret> token=/private/path');}}});await safe.run('.his @safe');assert.equal(safe.edits.at(-1).text,'❌ <b>操作失败</b>，请稍后重试');
});

test('HIS-COMPAT-07 reply lookup and first result transport errors never disclose private details',async t=>{
  const replyFailure=await fixture(t,{getReplyFailure:true});await replyFailure.run('.his');
  assert.equal(replyFailure.edits.at(-1).text,'❌ <b>操作失败</b>，请稍后重试');
  assert.doesNotMatch(JSON.stringify({edits:replyFailure.edits,logs:replyFailure.logs}),/private-secret|private\/path/);
  const finalFailure=await fixture(t,{failEditAt:2});await finalFailure.run('.his @alice 1');
  assert.equal(finalFailure.edits.at(-1).text,'❌ <b>操作失败</b>，请稍后重试');
  assert.doesNotMatch(JSON.stringify({edits:finalFailure.edits,logs:finalFailure.logs}),/private-secret|private\/path/);
});

test('HIS-COMPAT-08 previews truncate by code point without splitting an emoji',async t=>{
  const text='😀'.repeat(51);
  const client={async getEntity(){return{};},async *iterMessages(){yield{id:1,text};}};
  const f=await fixture(t,{client});await f.run('.his @emoji 1');const output=f.edits.at(-1).text;
  assert.match(output,new RegExp(`${'😀'.repeat(50)}\\.\\.\\.`));
  assert.equal(output.includes('\ud83d...'),false);
});

test('HIS-COMPAT-09 cancellation during iteration publishes no partial history',async t=>{
  const entered=deferred(),release=deferred();
  const client={async getEntity(){return{};},async *iterMessages(){yield{id:1,text:'first'};entered.resolve();await release.promise;yield{id:2,text:'second'};}};
  const f=await fixture(t,{client});const running=f.run('.his @alice 2');await entered.promise;const unloading=f.host.unload('his',1000);release.resolve();assert.equal((await unloading).completed,true);await running;
  assert.deepEqual(f.edits.map(item=>item.text),['🔍 正在查询消息历史...']);assert.deepEqual(f.replies,[]);
});
