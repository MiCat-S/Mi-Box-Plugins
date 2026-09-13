'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const utils = require(path.join(core, 'node_modules/teleproto/Utils.js'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

async function fixture(t, client) {
  const {artifactDir} = buildPlugin({id:'clear_sticker',packageRoot:path.resolve(__dirname,'../clear_sticker'),entry:'v2.ts'});
  const create=require(path.join(artifactDir,'index.cjs')).default;
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mibot-clear-sticker-')));
  const edits=[],logs=[];
  const host=new PluginHost({storageRoot:root,logger:{info(event,fields){logs.push({level:'info',event,fields});},error(event,fields){logs.push({level:'error',event,fields});}},telegram:{
    async edit(message,text,options){edits.push({message,text,options});},async reply(){},async invoke(request){return client.invoke(request);},async getReply(){},async withClient(operation,signal){return operation(client,signal);},
  }});
  await host.load(create());
  t.after(async()=>{assert.equal((await host.shutdown(2000)).completed,true);await fs.rm(root,{recursive:true,force:true});});
  return{host,edits,logs,run:(text,extra={})=>host.dispatchPrimary({id:20,chatId:'-1009007199254740993',senderId:'1',outgoing:true,text,...extra})};
}

function sticker(id) {return new Api.Message({id,peerId:new Api.PeerChannel({channelId:7}),message:'',media:new Api.MessageMediaDocument({document:new Api.Document({id,accessHash:1,fileReference:Buffer.alloc(0),date:0,mimeType:'image/webp',size:1,dcId:1,attributes:[new Api.DocumentAttributeSticker({alt:'x',stickerset:new Api.InputStickerSetEmpty()})]})})});}

test('private chats are rejected before history RPC',async t=>{let invoked=0;const f=await fixture(t,{async invoke(){invoked++;}});await f.run('.clear_sticker',{chatType:'private',raw:{peerId:new Api.PeerUser({userId:9})}});assert.equal(invoked,0);assert.match(f.edits.at(-1).text,/只能在群组/);});

test('valid integer keeps the 2000 cap, ignores later arguments, and serializes the TL request',async t=>{const requests=[],deleted=[];const peer=new Api.InputPeerChannel({channelId:7,accessHash:8});const client={async getInputEntity(){return peer;},async invoke(request){requests.push(request);await request.resolve(client,utils);assert.ok(request.getBytes().length>0);return{messages:requests.length===1?Array.from({length:100},(_,i)=>sticker(i+1)):[]};},async deleteMessages(target,ids,options){deleted.push({target,ids,options});}};const f=await fixture(t,client);await f.run('.cs 9999 extra',{chatType:'supergroup',raw:{peerId:new Api.PeerChannel({channelId:7})}});assert.equal(requests.length,2);assert.equal(deleted[0].ids.length,100);assert.equal(deleted[0].options.revoke,true);assert.match(f.edits.at(-1).text,/删除 100 条/);});

test('malformed numeric prefixes are rejected without history RPC',async t=>{let invoked=0;const f=await fixture(t,{async invoke(){invoked++;}});for(const value of ['1abc','1.5']){await f.run(`.clear_sticker ${value}`,{chatType:'supergroup',raw:{peerId:new Api.PeerChannel({channelId:7})}});assert.match(f.edits.at(-1).text,/请输入有效数量/);}assert.equal(invoked,0);});

test('integer limits from 1 through 2000 are accepted',async t=>{for(const value of ['1','2000']){let invoked=0;const peer=new Api.InputPeerChannel({channelId:7,accessHash:8});const f=await fixture(t,{async getInputEntity(){return peer;},async invoke(){invoked++;return{messages:[]};}});await f.run(`.clear_sticker ${value}`,{chatType:'supergroup',raw:{peerId:new Api.PeerChannel({channelId:7})}});assert.equal(invoked,1);assert.match(f.edits.at(-1).text,/未找到贴纸/);}});

test('batch delete failure is logged and scanning completes without claiming deletion',async t=>{const peer=new Api.InputPeerChannel({channelId:7,accessHash:8});const client={async getInputEntity(){return peer;},async invoke(){return{messages:[sticker(4)]};},async deleteMessages(){throw new Error('secret');}};const f=await fixture(t,client);await f.run('.clear_sticker 1',{chatType:'supergroup',raw:{peerId:new Api.PeerChannel({channelId:7})}});assert.match(f.edits.at(-1).text,/未找到贴纸/);assert.equal(f.logs.some(x=>x.event==='clear_sticker_delete_failed'),true);assert.equal(JSON.stringify(f.logs).includes('secret'),false);});

test('cancellation during history produces no later RPC, receipt task, or failure log',async t=>{let release;let invokes=0;const peer=new Api.InputPeerChannel({channelId:7,accessHash:8});const f=await fixture(t,{async getInputEntity(){return peer;},async invoke(){invokes++;return new Promise(resolve=>{release=resolve;});},async deleteMessages(){assert.fail('must not delete');}});const running=f.run('.clear_sticker 1',{chatType:'supergroup',raw:{peerId:new Api.PeerChannel({channelId:7})}});while(!release)await new Promise(resolve=>setImmediate(resolve));const unloading=f.host.unload('clear_sticker',1000);release({messages:[sticker(1)]});await Promise.all([running,unloading]);assert.equal(invokes,1);assert.equal(f.edits.length,1);assert.deepEqual(f.logs,[]);});

test('cancellation during deletion produces no progress, receipt task, or failure log',async t=>{let releaseDelete;let deletes=0;const peer=new Api.InputPeerChannel({channelId:7,accessHash:8});const f=await fixture(t,{async getInputEntity(){return peer;},async invoke(){return{messages:[sticker(1)]};},async deleteMessages(){deletes++;return new Promise(resolve=>{releaseDelete=resolve;});}});const running=f.run('.clear_sticker 1',{chatType:'supergroup',raw:{peerId:new Api.PeerChannel({channelId:7})}});while(!releaseDelete)await new Promise(resolve=>setImmediate(resolve));const unloading=f.host.unload('clear_sticker',1000);releaseDelete();await Promise.all([running,unloading]);assert.equal(deletes,1);assert.equal(f.edits.length,1);assert.deepEqual(f.logs,[]);});
