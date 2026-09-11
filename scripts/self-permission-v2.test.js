'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const test=require('node:test'),os=require('node:os');
const root=os.tmpdir(),core=path.resolve(__dirname,'../../TeleBox-Core');
const {buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));
const {PluginHost}=require(path.join(core,'dist/v2/host.js'));
const {ResourceScope}=require(path.join(core,'dist/v2/lifecycle.js'));
const {prepareArtifact}=require(path.join(core,'dist/v2/artifacts.js'));
const {Api,utils}=require(path.join(core,'node_modules/teleproto'));
const {returnBigInt:integer}=require(path.join(core,'node_modules/teleproto/Helpers.js'));
function plugin(id){const built=buildPlugin({id,packageRoot:path.resolve(__dirname,'..',id),entry:'v2.ts'});return require(path.join(built.artifactDir,'index.cjs')).default();}
const user=new Api.User({id:integer(1),accessHash:integer(33),firstName:'Owner'});
const channel=broadcast=>new Api.Channel({id:integer(10),accessHash:integer(44),title:'Test',megagroup:!broadcast,broadcast,photo:new Api.ChatPhotoEmpty(),date:0});
const peer=new Api.PeerChannel({channelId:integer(10)});
function input(value){if(value instanceof Api.InputPeerSelf||value instanceof Api.InputPeerUser||value instanceof Api.InputPeerChannel)return value;if(value instanceof Api.InputChannel||value instanceof Api.PeerChannel)return new Api.InputPeerChannel({channelId:value.channelId,accessHash:integer(44)});if(value instanceof Api.Channel)return new Api.InputPeerChannel({channelId:value.id,accessHash:value.accessHash});return new Api.InputPeerUser({userId:integer(value?.id??value?.userId??value),accessHash:integer(33)});}
async function context(id,broadcast=false){
 const chat=channel(broadcast),scope=new ResourceScope(),saved=new Map(),errors=[],calls=[],edits=[];
 const native={getMe:async()=>user,getEntity:async v=>typeof v==='string'&&/^2$/.test(v)?new Api.User({id:integer(2),accessHash:integer(55),firstName:'Target'}):chat,getInputEntity:async v=>input(v),
  getMessages:async()=>[],iterMessages:async function*(){},iterDialogs:async function*(){},iterParticipants:async function*(){},deleteMessages:async()=>[],sendMessage:async()=>({id:501}),editMessage:async()=>{},sendFile:async()=>{},
  invoke:async request=>{calls.push(request.className);try{await request.resolve({getInputEntity:async v=>input(v)},utils);request.getBytes();}catch(e){errors.push({rpc:request.className,error:e.message});throw e;}
   if(request instanceof Api.channels.GetParticipant)return{participant:new Api.ChannelParticipantCreator({userId:user.id})};
   if(request instanceof Api.channels.GetParticipants)return{users:[],participants:[]};
   if(request instanceof Api.channels.GetSendAs)return{peers:[]};
   return{messages:[],users:[],offset:0};
  }};
 const tmp=await fs.mkdtemp(path.join(root,`repro-${id}-`));
 const ctx={signal:scope.signal,tasks:scope,log:{info(){},error(){}},files:{dataPath:n=>path.join(tmp,n??''),dataFile:async n=>path.join(tmp,n),withTemp:async fn=>fn(tmp,scope.signal)},
  storage:{json:(name,defaults)=>{if(!saved.has(name))saved.set(name,structuredClone(defaults));return{read:async()=>structuredClone(saved.get(name)),update:async fn=>{const next=await fn(structuredClone(saved.get(name)));saved.set(name,next);return structuredClone(next);}}}},
  telegram:{edit:async(_m,t)=>edits.push(t),reply:async(_m,t)=>edits.push(t),getReply:async()=>undefined,withClient:fn=>fn(native,scope.signal)}};
 return{ctx,scope,saved,errors,calls,edits,native,tmp};
}
for(const [id,command,args] of [['bulk_delete','bd',[]],['clean_member','clean_member',['4']],['clean','clean',['deleted','member','rm']],['manage_admin','manage_admin',['add','2']],['paolu','paolu',[]],['dme','dme',['-f','1']],['da','da',['true']]]) test(`${id} resolves and serializes the self-permission RPC`,async()=>{
 const d=plugin(id),f=await context(id,id==='dme');const message={id:10,chatId:'-10010',senderId:'1',outgoing:true,text:`.${command} ${args.join(' ')}`,replyToId:8,raw:{id:10,peerId:peer,isChannel:true,isGroup:id!=='dme',className:'Message'}};
 try{await d.commands[command].handle({message,command,args,prefix:'.'},f.ctx);for(let i=0;i<100&&!f.errors.length;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.errors,[]);
  assert.ok(f.calls.includes('channels.GetParticipant'),JSON.stringify(f.edits));
  assert.ok(!f.edits.some(text=>/权限不足|无法确认管理员|没有封禁用户权限/.test(text)),JSON.stringify(f.edits));
 }finally{assert.equal((await f.scope.drain(2000)).completed,true);await fs.rm(f.tmp,{recursive:true,force:true});}
});
