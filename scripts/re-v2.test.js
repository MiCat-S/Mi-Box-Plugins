'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const core=path.resolve(__dirname,'../../TeleBox-Core');
const {Api}=require(path.join(core,'node_modules/teleproto'));
const {returnBigInt}=require(path.join(core,'node_modules/teleproto/Helpers.js'));
const utils=require(path.join(core,'node_modules/teleproto/Utils.js'));
const {buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));
const {PluginHost}=require(path.join(core,'dist/v2/host.js'));
const {artifactDir}=buildPlugin({id:'re',packageRoot:path.resolve(__dirname,'../re'),entry:'v2.ts'});
const create=require(path.join(artifactDir,'index.cjs')).default;
const source=new Api.InputPeerChannel({channelId:returnBigInt(10),accessHash:returnBigInt(11)}),target=new Api.InputPeerChannel({channelId:returnBigInt(20),accessHash:returnBigInt(21)});

async function fixture(t,{reply,client:patch={},prefixes=['.']}={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mibot-re-v2-'))),edits=[],replies=[],logs=[],invokes=[],files=[],sent=[];let deleted=0;
 const client={async getMessages(){return[];},async getInputEntity(value){return value;},async invoke(request){invokes.push(request);return{};},async sendFile(peer,value){files.push({peer,value});},async sendMessage(peer,value){sent.push({peer,value});},...patch};
 const host=new PluginHost({storageRoot:root,prefixes,logger:{info(){},error(event,fields){logs.push({event,fields});}},telegram:{async edit(_m,text,options){edits.push({text,options});},async reply(_m,text,options){replies.push({text,options});},async invoke(request){return client.invoke(request);},async getReply(){return reply;},async withClient(op,signal){return op(client,signal);}}});
 await host.load(create());t.after(async()=>{await host.shutdown(1000);await fs.rm(root,{recursive:true,force:true});});
 const run=(text,extra={})=>host.dispatchPrimary({id:50,chatId:'-10020',senderId:'9',outgoing:true,text,raw:{peerId:target,async getInputChat(){return target;},async delete(options){assert.equal(options.revoke,true);deleted++;}},...extra});
 return{host,edits,replies,logs,invokes,files,sent,run,deleted:()=>deleted};
}

function replied(messages={}){return{id:30,chatId:'-10010',senderId:'8',outgoing:false,text:'reply',raw:{peerId:source,replyTo:{replyToTopId:77},async getInputChat(){return source;}},...messages};}

test('re requires a reply and uses the active prefix in help',async t=>{const f=await fixture(t,{prefixes:['!']});await f.run('!re');assert.match(f.edits.at(-1).text,/必须回复/);assert.equal(f.invokes.length,0);});

test('re distinguishes a missing replied message payload from no reply',async t=>{const f=await fixture(t,{reply:{id:30,chatId:'-10010',outgoing:false,text:'missing'}});await f.run('.re');assert.equal(f.replies.at(-1).text,'无法获取被回复的消息，请重试。');assert.equal(f.invokes.length,0);});

test('re fetches actual non-contiguous history and forwards it repeatedly with topic metadata',async t=>{
 const history=[new Api.Message({id:25,peerId:new Api.PeerChannel({channelId:returnBigInt(10)}),message:'a'}),new Api.Message({id:30,peerId:new Api.PeerChannel({channelId:returnBigInt(10)}),message:'b'})];let options;
 const f=await fixture(t,{reply:replied(),client:{async getMessages(peer,value){assert.equal(peer,source);options=value;return history;},async invoke(request){await request.resolve(this,utils);assert.ok(request.getBytes().length>0);f.invokes.push(request);return{};}}});
 await f.run('.re 5 2');assert.deepEqual(options,{offsetId:29,limit:5,reverse:true});assert.equal(f.invokes.length,2);for(const request of f.invokes){assert.ok(request instanceof Api.messages.ForwardMessages);assert.deepEqual(request.id,[25,30]);assert.equal(request.topMsgId,77);}assert.equal(f.deleted(),1);
});

test('re copies text, media and entities for every repeat when forwarding is restricted',async t=>{
 const entity=new Api.MessageEntityBold({offset:0,length:4}),media={className:'MessageMediaDocument'};const history=[{id:1,message:'text',entities:[entity]},{id:2,message:'caption',media,entities:[entity]}];let calls=0;
 const f=await fixture(t,{reply:replied(),client:{async getMessages(){return history;},async invoke(){calls++;throw Object.assign(new Error('restricted'),{errorMessage:'CHAT_FORWARDS_RESTRICTED'});}}});
 await f.run('.re 2 2');assert.equal(calls,1);assert.equal(f.sent.length,2);assert.equal(f.files.length,2);assert.ok(f.sent.every(item=>item.value.replyTo===77&&item.value.formattingEntities[0]===entity));assert.ok(f.files.every(item=>item.value.file===media&&item.value.caption==='caption'&&item.value.replyTo===77));
});

test('re copy fallback only fills repetitions not already forwarded successfully',async t=>{
 let calls=0;const f=await fixture(t,{reply:replied(),client:{async getMessages(){return[{id:30,message:'text'}];},async invoke(){if(++calls===2)throw Object.assign(new Error('restricted'),{errorMessage:'CHAT_FORWARDS_RESTRICTED'});}}});
 await f.run('.re 1 2');assert.equal(calls,2);assert.equal(f.sent.length,1,'one successful forward plus one copied repetition equals the requested two');assert.equal(f.sent[0].value.message,'text');
});

test('re clamps work bounds and reports unknown native failures without exception details',async t=>{
 let fetched;const error=Object.assign(new Error('SECRET_MESSAGE'),{name:'SECRET_NAME',errorMessage:'OTHER_SECRET'});const f=await fixture(t,{reply:replied(),client:{async getMessages(_peer,options){fetched=options;return[{id:30,message:'x'}];},async invoke(){throw error;}}});
 await f.run('.re 999 999');assert.equal(fetched.limit,20);assert.equal(f.replies.at(-1).text,'发生未知错误，无法复读消息。请稍后再试。');assert.deepEqual(f.logs,[{event:'re_failed',fields:{kind:'internal'}}]);assert.doesNotMatch(JSON.stringify({logs:f.logs,replies:f.replies}),/SECRET/);
});

test('re cancellation after history settlement starts no delete or forward',async t=>{
 let entered,release,invokes=0;const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});const f=await fixture(t,{reply:replied(),client:{async getMessages(){entered();await gate;return[{id:30,message:'x'}];},async invoke(){invokes++;}}});
 const pending=f.run('.re');await ready;const unloading=f.host.unload('re',1000);release();assert.equal((await unloading).completed,true);await assert.rejects(pending,e=>e?.name==='AbortError'||e?.name==='TelegramAbortError');assert.equal(f.deleted(),0);assert.equal(invokes,0);
});
