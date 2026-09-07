'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const core=path.resolve(__dirname,'../../TeleBox-Core'),{buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));
const create=require(path.join(buildPlugin({id:'clean',packageRoot:path.resolve(__dirname,'../clean'),entry:'v2.ts'}).artifactDir,'index.cjs')).default;
const msg=(text,extra={})=>({id:9,chatId:'1',text,outgoing:true,raw:{isPrivate:true},...extra});
function ctx(client){const edits=[];const signal=new AbortController().signal;return{edits,ctx:{signal,log:{info(){},error(){}},telegram:{edit:async(m,text)=>edits.push(text),withClient:fn=>fn(client,signal)}}};}
test('clean exposes guarded command and help',async()=>{const p=create();assert.equal(p.commands.clean.ignoreEdited,true);const f=ctx({});await p.commands.clean.handle({message:msg('.clean'),args:[],prefix:'.',command:'clean'},f.ctx);assert.match(f.edits[0],/deleted pm/);});
test('deleted pm deduplicates archive dialogs and reports partial deletion',async()=>{const user={className:'User',deleted:true,id:2n};const d={isUser:true,entity:user,inputEntity:'u'};const client={async *iterDialogs({folder}){yield d;if(folder===1)yield{...d};},async deleteDialog(){throw new Error('denied')}};const f=ctx(client);await create().commands.clean.handle({message:msg('.clean deleted pm rm'),args:['deleted','pm','rm'],prefix:'.',command:'clean'},f.ctx);assert.match(f.edits.at(-1),/共找到 <code>1<\/code>/);assert.match(f.edits.at(-1),/失败 <code>1<\/code>/);});
