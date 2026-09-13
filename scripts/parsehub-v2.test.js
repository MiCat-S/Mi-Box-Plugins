'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {setImmediate:nextTurn}=require('node:timers/promises');
const {performance}=require('node:perf_hooks');
const core=path.resolve(__dirname,'../../TeleBox-Core');
const {Api}=require(path.join(core,'node_modules/teleproto'));
const {returnBigInt}=require(path.join(core,'node_modules/teleproto/Helpers.js'));
const utils=require(path.join(core,'node_modules/teleproto/Utils.js'));
const {buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));
const {PluginHost}=require(path.join(core,'dist/v2/host.js'));
const {artifactDir}=buildPlugin({id:'parsehub',packageRoot:path.resolve(__dirname,'../parsehub'),entry:'v2.ts'});
const built=require(path.join(artifactDir,'index.cjs')),create=built.default;

function deferred(){let resolve,reject,settled=false;const promise=new Promise((yes,no)=>{resolve=value=>{settled=true;yes(value);};reject=error=>{settled=true;no(error);};});return{promise,resolve,reject,settled:()=>settled};}
async function pumpUntil(t,predicate,{step=500,timeout=5000}={}){const deadline=performance.now()+timeout;while(!predicate()){if(performance.now()>=deadline)throw new Error('fake-clock condition did not settle');await nextTurn();if(step)t.mock.timers.tick(step);await nextTurn();}}
async function fixture(t,{state={schemaVersion:1,initialized:true,ignoredUpToId:10},client:patch={},onDelete,onEdit,reply}={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mibot-parsehub-v2-'))),dir=path.join(root,'parsehub');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(state));
 const edits=[],replies=[],forwarded=[],sent=[],logs=[];
 const client={async getMessages(){return[{id:10,out:false,className:'Message',message:'welcome'}];},async getEntity(){return{id:returnBigInt(7),accessHash:returnBigInt(8)};},async getInputEntity(){return new Api.InputPeerUser({userId:returnBigInt(7),accessHash:returnBigInt(8)});},_getInputNotify(peer){return peer instanceof Api.InputNotifyPeer?peer:new Api.InputNotifyPeer({peer});},async invoke(){return{};},async sendMessage(peer,value){sent.push({peer,value});return{id:10,out:true};},async forwardMessages(peer,value){forwarded.push({peer,value});},...patch};
 const host=new PluginHost({storageRoot:root,concurrency:4,logger:{info(){},error(event,fields){logs.push({event,fields});}},telegram:{async edit(message,text,options){await onEdit?.(message,text);edits.push({message,text,options});},async reply(message,text,options){replies.push({message,text,options});},async invoke(request){return client.invoke(request);},async getReply(){return reply;},async withClient(op,signal){return op(client,signal);}}});
 await host.load(create());t.after(async()=>{await host.shutdown(1000);await fs.rm(root,{recursive:true,force:true});});
 const run=(text,{chatId='-1001',topicId,replyToId,omitRaw=false}={})=>host.dispatchPrimary({id:1,chatId,senderId:'9',outgoing:true,text,...(topicId===undefined?{}:{topicId}),...(replyToId===undefined?{}:{replyToId}),...(omitRaw?{}:{raw:{peerId:{chatId},async delete(options){await onDelete?.(options);}}})});
 return{root,host,client,edits,replies,forwarded,sent,logs,run,read:async()=>JSON.parse(await fs.readFile(path.join(dir,'state.json'),'utf8'))};
}

test('parsehub extracts bounded safe links and classifies progress and final media',()=>{
 assert.deepEqual(built.extractLinks('x www.example.com/a). https://u:p@example.com/no https://example.com/a。'),['https://www.example.com/a','https://example.com/a']);
 assert.equal(built.extractLinks(Array.from({length:12},(_,i)=>`https://e.test/${i}`).join(' ')).length,10);
 assert.equal(built.isProgressText(' ▓ 解 析 中 50%'),true);assert.equal(built.isFinalBotMessage({message:'解 析 中 50%'}),false);assert.equal(built.isFinalBotMessage({message:'',media:{className:'MessageMediaDocument'}}),true);
});

test('parsehub ignores same-second old IDs, accepts a progress edit as final media and preserves topic reply',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout']});let reads=0,serialized=0;const submitted=deferred(),media={className:'MessageMediaDocument'};const history=[{id:10,out:false,date:1,className:'Message',message:'old',media:{className:'MessageMediaDocument'}}];
 const f=await fixture(t,{client:{async getMessages(){reads++;if(reads===3)history.unshift({id:11,out:false,date:1,className:'Message',message:'解 析 中 50%'});else if(reads===4)history[history.findIndex(item=>item.id===11)]={id:11,out:false,date:1,className:'Message',message:'done',media};return history.slice();},async sendMessage(){submitted.resolve();return{id:10,out:true};},async invoke(request){if(request instanceof Api.account.UpdateNotifySettings){await request.resolve(this,utils);assert.ok(request.getBytes().length>0);serialized++;}return{};}}});
 const running=f.run('.parsehub https://example.com/post',{chatId:'-1009007199254740993',topicId:77});
 await pumpUntil(t,submitted.settled,{step:0});await submitted.promise;await pumpUntil(t,()=>f.edits.some(x=>/处理完成/.test(x.text)),{step:2000});t.mock.timers.reset();await running;
 assert.deepEqual(f.forwarded.map(x=>x.value.messages),[[11]]);assert.equal(f.forwarded[0].value.replyTo,1);assert.equal(f.forwarded[0].value.topMsgId,77);assert.match(f.edits.at(-1).text,/1\/1/);assert.equal((await f.read()).ignoredUpToId,11);assert.equal(serialized,1);
});

test('parsehub welcome timeout sends no business link and never marks initialization successful',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout']});const sent=[];const f=await fixture(t,{state:{schemaVersion:1,initialized:false,ignoredUpToId:0,future:'keep'},client:{async getMessages(){return[];},async sendMessage(_peer,value){sent.push(value.message);return{id:5,out:true};}}});
 const running=f.run('.parsehub https://example.com/business');await pumpUntil(t,()=>sent.length===1,{step:0});await pumpUntil(t,()=>f.edits.some(x=>/解析失败/.test(x.text)),{step:500});t.mock.timers.reset();await running;
 assert.deepEqual(sent,['/start']);assert.equal(f.edits.some(x=>/处理完成/.test(x.text)),false);assert.match(f.edits.at(-1).text,/解析失败/);const saved=await f.read();assert.equal(saved.initialized,false);assert.equal(saved.ignoredUpToId,5);assert.equal(saved.future,'keep');
});

test('parsehub serializes chats and queued cancellation cannot overtake its predecessor',async t=>{
 const entered=deferred(),release=deferred(),business=[];const f=await fixture(t,{client:{async sendMessage(_peer,value){if(value.message.startsWith('http')){business.push(value.message);if(business.length===1){entered.resolve();await release.promise;}}return{id:11,out:true};},async getMessages(){return[{id:10,out:false,className:'Message',message:'welcome'}];}}});
 const first=f.run('.parsehub https://example.com/first',{chatId:'-1001'});await entered.promise;const second=f.run('.parsehub https://example.com/second',{chatId:'-1002'});await nextTurn();assert.deepEqual(business,['https://example.com/first']);const unloading=f.host.unload('parsehub',1000);await assert.rejects(second,e=>e?.name==='AbortError'||e?.name==='TelegramAbortError');release.resolve();assert.equal((await unloading).completed,true);await assert.rejects(first,e=>e?.name==='AbortError'||e?.name==='TelegramAbortError');assert.deepEqual(business,['https://example.com/first']);
});

test('parsehub normalizes damaged legacy state without marking failed initialization successful',async t=>{
 const f=await fixture(t,{state:{initialized:'yes',ignoredUpToId:'9007199254740993',future:'keep'},client:{async getMessages(){throw Object.assign(new Error('SECRET'),{name:'SECRET_NAME'});}}});const saved=await f.read();assert.equal(saved.initialized,false);assert.equal(saved.ignoredUpToId,0);assert.equal(saved.future,'keep');
 assert.deepEqual(f.logs,[]);assert.doesNotMatch(JSON.stringify(f.logs),/SECRET/);
});

test('parsehub merges command and reply links in order but submits only the first like Legacy',async t=>{
 const submitted=deferred(),gate=deferred(),business=[];const f=await fixture(t,{reply:{text:'reply https://reply.test/b https://reply.test/c'},client:{async sendMessage(_peer,value){if(value.message.startsWith('http')){business.push(value.message);submitted.resolve();await gate.promise;}return{id:11,out:true};}}});
 const running=f.run('.parsehub https://command.test/a https://command.test/a',{replyToId:9});await submitted.promise;assert.deepEqual(business,['https://command.test/a']);const unloading=f.host.unload('parsehub',1000);gate.resolve();assert.equal((await unloading).completed,true);await assert.rejects(running,e=>e?.name==='AbortError'||e?.name==='TelegramAbortError');
});

test('parsehub paginates text fallback completely and cleanup failure cannot reverse success',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout']});let reads=0;const submitted=deferred(),finals=[1,2].map((_,i)=>({id:11+i,out:false,className:'Message',message:String.fromCodePoint(0x1f600).repeat(1800)}));
 const f=await fixture(t,{onDelete:async()=>{throw new Error('SECRET_DELETE');},client:{async getMessages(){return reads++<2?[{id:10,out:false,className:'Message',message:'welcome'}]:finals;},async sendMessage(peer,value){f.sent.push({peer,value});if(peer==='@ParseHubot')submitted.resolve();return{id:10,out:true};},async forwardMessages(){throw new Error('forward failed');}}});
 const running=f.run('.parsehub https://example.com/post');await pumpUntil(t,submitted.settled,{step:0});await submitted.promise;await pumpUntil(t,()=>f.edits.some(x=>/处理完成/.test(x.text)),{step:2000});t.mock.timers.reset();await running;
 const pages=f.sent.filter(x=>x.peer!=='@ParseHubot').map(x=>x.value.message);assert.ok(pages.length>1);assert.ok(pages.every(x=>x.length<=3500));assert.equal(Array.from(pages.join('').replace(/\n\d+\/\d+ 页/g,'')).filter(x=>x==='😀').length,3600);assert.match(f.edits.at(-1).text,/1\/1/);assert.deepEqual(f.logs.at(-1),{event:'parsehub_cleanup_failed',fields:{kind:'internal'}});assert.doesNotMatch(JSON.stringify(f.logs),/SECRET_DELETE/);
});

test('parsehub resolves a rawless large chat ID without numeric precision loss',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout']});const submitted=deferred(),inputs=[],history=[{id:10,out:false,className:'Message',message:'welcome'}];
 const f=await fixture(t,{client:{async getInputEntity(value){if(typeof value!=='string')inputs.push(value);return new Api.InputPeerChannel({channelId:returnBigInt(1),accessHash:returnBigInt(2)});},async sendMessage(){submitted.resolve();history.unshift({id:11,out:false,className:'Message',message:'done'});return{id:10,out:true};},async getMessages(){return history.slice();}}});
 const chatId='-1009007199254740993',running=f.run('.parsehub https://example.com/rawless',{chatId,omitRaw:true});await pumpUntil(t,submitted.settled,{step:0});await submitted.promise;await pumpUntil(t,()=>f.edits.some(x=>/处理完成/.test(x.text)),{step:2000});t.mock.timers.reset();await running;assert.equal(inputs.length,1);assert.equal(inputs[0].toString(),chatId);
});

test('parsehub reports incomplete when a failed mixed batch falls back text but loses captioned media',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout']});const submitted=deferred();let reads=0,calls=0;const finals=Array.from({length:102},(_,i)=>({id:11+i,out:false,className:'Message',message:i===101?'video caption':`text-${i}`,...(i===101?{media:{className:'MessageMediaDocument'}}:{})}));
 const f=await fixture(t,{client:{async getMessages(){return reads++<2?[{id:10,out:false,className:'Message',message:'welcome'}]:finals;},async sendMessage(peer,value){f.sent.push({peer,value});if(peer==='@ParseHubot')submitted.resolve();return{id:10,out:true};},async forwardMessages(){if(++calls===2)throw new Error('second batch failed');}}});
 const running=f.run('.parsehub https://example.com/many');await pumpUntil(t,submitted.settled,{step:0});await submitted.promise;await pumpUntil(t,()=>f.edits.some(x=>/处理完成/.test(x.text)),{step:2000});t.mock.timers.reset();await running;assert.equal(calls,2);const fallback=f.sent.filter(item=>item.peer!=='@ParseHubot').map(item=>item.value.message).join('\n');assert.match(fallback,/text-100/);assert.match(fallback,/video caption/);assert.match(f.replies.at(-1).text,/解析未完成/);assert.match(f.edits.at(-1).text,/0\/1/);
});

test('parsehub final receipt failure cannot turn successful forwarding into a business failure',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout']});const submitted=deferred();let reads=0,deletes=0;
 const f=await fixture(t,{onDelete:async()=>{deletes++;},onEdit:async(_message,text)=>{if(/处理完成/.test(text))throw new Error('SECRET_RECEIPT');},client:{async getMessages(){return reads++<2?[{id:10,out:false,className:'Message',message:'welcome'}]:[{id:11,out:false,className:'Message',message:'done'}];},async sendMessage(){submitted.resolve();return{id:10,out:true};}}});
 const running=f.run('.parsehub https://example.com/receipt');await pumpUntil(t,submitted.settled,{step:0});await submitted.promise;await pumpUntil(t,()=>f.logs.some(x=>x.event==='parsehub_receipt_failed'),{step:2000});t.mock.timers.reset();await running;assert.equal(f.forwarded.length,1);assert.equal(f.edits.some(x=>/解析失败/.test(x.text)),false);assert.equal(deletes,1);assert.deepEqual(f.logs.at(-1),{event:'parsehub_receipt_failed',fields:{kind:'internal'}});assert.doesNotMatch(JSON.stringify(f.logs),/SECRET_RECEIPT/);
});

test('parsehub cancellation while the completion receipt is in flight starts no late cleanup',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout']});const submitted=deferred(),receipt=deferred(),gate=deferred();let reads=0,deletes=0,receiptReached=false;
 const f=await fixture(t,{onDelete:async()=>{deletes++;},onEdit:async(_message,text)=>{if(/处理完成/.test(text)){receiptReached=true;receipt.resolve();await gate.promise;}},client:{async getMessages(){return reads++<2?[{id:10,out:false,className:'Message',message:'welcome'}]:[{id:11,out:false,className:'Message',message:'done'}];},async sendMessage(){submitted.resolve();return{id:10,out:true};}}});
 const running=f.run('.parsehub https://example.com/cancel-cleanup');try{await pumpUntil(t,submitted.settled,{step:0});await submitted.promise;await pumpUntil(t,()=>receiptReached,{step:2000});await receipt.promise;t.mock.timers.reset();const unloading=f.host.unload('parsehub',1000);gate.resolve();assert.equal((await unloading).completed,true);await assert.rejects(running,e=>e?.name==='AbortError'||e?.name==='TelegramAbortError');assert.equal(deletes,0);}catch(error){gate.resolve();await f.host.unload('parsehub',1000);throw error;}
});

test('predicate pump does not reset the fake clock before delayed storage admits the command',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout']});const gate=deferred(),entered=deferred(),originalOpen=fs.open;let delayed=true,settled=false;
 const f=await fixture(t,{state:{schemaVersion:1,initialized:false,ignoredUpToId:0},client:{async getMessages(){return[];},async sendMessage(){return{id:5,out:true};}}});
 fs.open=async function(file,...args){if(delayed&&String(file).endsWith('/parsehub/state.json')){delayed=false;entered.resolve();await gate.promise;}return originalOpen.call(this,file,...args);};
 t.after(()=>{fs.open=originalOpen;});
 const running=f.run('.parsehub https://example.com/delayed-storage').finally(()=>{settled=true;});void running.catch(()=>{});try{await pumpUntil(t,entered.settled,{step:0});await entered.promise;
 for(let i=0;i<30;i++){await nextTurn();t.mock.timers.tick(500);await nextTurn();}
 assert.equal(settled,false,'the old fixed tick budget ends before the delayed storage operation starts polling');
 gate.resolve();await pumpUntil(t,()=>settled,{step:500});t.mock.timers.reset();await running;
 }finally{fs.open=originalOpen;gate.resolve();t.mock.timers.reset();}
});
