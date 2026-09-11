'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const core=path.resolve(__dirname,'../../TeleBox-Core');const {buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));const create=require(path.join(buildPlugin({id:'bulk_delete',packageRoot:path.resolve(__dirname,'../bulk_delete'),entry:'v2.ts'}).artifactDir,'index.cjs')).default;
function fixture(initial={schemaVersion:1,userDeleteMode:{}}){let data=structuredClone(initial);const sent=[],deleted=[],tasks=[];const client={async getMe(){return{id:1n}},async getMessages(){return[{id:9,senderId:1n},{id:8,senderId:2n}]},async deleteMessages(chat,ids){deleted.push(ids)},async sendMessage(chat,value){sent.push(value);return{id:50}},async getEntity(){return{className:'User'}}};const context={signal:new AbortController().signal,storage:{json(){return{async read(){return structuredClone(data)},async update(fn){data=await fn(structuredClone(data));return data}}}},tasks:{run(name,fn){tasks.push(name);return Promise.resolve()}},telegram:{withClient(fn){return fn(client,context.signal)}}};return{sent,deleted,tasks,data:()=>data,run:(args,message={id:10,chatId:'7',text:'.bd '+args.join(' '),outgoing:true,raw:{chatId:'7'}})=>create().commands.bd.handle({message,args,command:'bd',prefix:'.'},context)};}
test('bd persists on/off and owns delayed cleanup',async()=>{const f=fixture();await f.run(['off']);assert.equal(f.data().userDeleteMode['1'],false);assert.match(f.sent[0].message,/关闭/);assert.match(f.tasks[0],/^bd:cleanup:/);});
test('bd numeric mode deletes only own recent messages',async()=>{const f=fixture();await f.run(['2']);assert.deepEqual(f.deleted[0],[10,9]);assert.match(f.sent[0].message,/1 条/);});

test('bd delayed cleanup releases abort listeners on completion and cancellation',async()=>{
  const fs=require('node:fs'),Module=require('node:module'),{getEventListeners}=require('node:events');
  const built=buildPlugin({id:'bulk_delete',packageRoot:path.resolve(__dirname,'../bulk_delete'),entry:'v2.ts'});
  const filename=path.join(built.artifactDir,'index.cjs'),candidate=new Module(filename);
  candidate.filename=filename;candidate.paths=Module._nodeModulePaths(path.dirname(filename));
  candidate._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports.delayForTest=sleep;',filename);
  const sleep=candidate.exports.delayForTest,controller=new AbortController();
  for(let i=0;i<12;i++)await sleep(0,controller.signal);
  assert.equal(getEventListeners(controller.signal,'abort').length,0);
  const pending=sleep(60000,controller.signal),reason=new Error('cancelled');controller.abort(reason);
  await assert.rejects(pending,error=>error===reason);
  assert.equal(getEventListeners(controller.signal,'abort').length,0);
  await assert.rejects(sleep(60000,controller.signal),error=>error===reason);
});
