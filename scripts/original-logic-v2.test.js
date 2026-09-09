'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const Module=require('node:module');
const core=path.resolve(__dirname,'../../TeleBox-Core');
const esbuild=require(path.join(core,'node_modules/esbuild'));
function helper(relative){
  const filename=path.join(core,'parity-helper.cjs');
  const code=esbuild.transformSync(fs.readFileSync(path.resolve(__dirname,'..',relative),'utf8'),{loader:'ts',format:'cjs',target:'node24'}).code;
  const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(core);mod._compile(code,filename);return mod.exports;
}
const questions=helper('pmcaptcha/v2/questions.ts');
const videos=helper('search/v2/videos.ts');
const reports=helper('komari/v2/reports.ts');
test('pmcaptcha generates six arithmetic operations with valid answers',t=>{
  const expected=[['10 + 10','20'],['11 - 10','1'],['2 × 11','22'],['6 ÷ 2','3'],['2 × 2 + 1','5'],['2²','4']];
  for(let type=0;type<6;type++){
    let first=true;t.mock.method(Math,'random',()=>{if(first){first=false;return(type+.1)/6;}return 0;});
    assert.deepEqual(questions.mathQuestion(),{question:expected[type][0],answer:expected[type][1]});t.mock.restoreAll();
  }
});
test('pmcaptcha draws all fifteen text questions and limits image tolerance to one edit',t=>{
  const seen=new Set();for(let i=0;i<15;i++){t.mock.method(Math,'random',()=>i/15);const q=questions.textQuestion();assert.ok(q.question);assert.ok(q.answer);seen.add(q.question);t.mock.restoreAll();}
  assert.equal(seen.size,15);assert.equal(questions.answerMatches(' h2O ','h2o',false),true);
  assert.equal(questions.answerMatches('ABCXE','ABCDE',true),true);assert.equal(questions.answerMatches('ABXXE','ABCDE',true),false);
  assert.equal(questions.answerMatches('ABCXE','ABCDE',false),false);
});
const video=(id,extra={})=>({id,video:{attributes:[{className:'DocumentAttributeVideo',duration:60}]},...extra});
test('search collects videos from keyword comment threads and complete albums',async()=>{
  const calls=[];const entity={className:'Channel'};
  const client={async getEntity(){return 'discussion';},async getMessages(peer,options){calls.push({peer,options});if(options.replyTo)return[video(11)];if(peer==='discussion')return[{id:10,text:'Movie One',replies:{}}];if(options.offsetId)return[{id:20,groupedId:7n,text:'Movie One'},video(21,{groupedId:7n}),video(22,{groupedId:8n})];return[{id:20,groupedId:7n,text:'Movie One'}];}};
  const found=await videos.channelVideos(client,entity,'linked','Movie One','search',()=>false,new Set(),new AbortController().signal);
  assert.deepEqual(found.map(x=>x.id),[11,21]);assert.ok(calls.some(x=>x.options.replyTo===10));
});
test('search prioritizes filename matches and constrains random video durations',async()=>{
  assert.equal(videos.score(video(1,{video:{attributes:[{className:'DocumentAttributeFilename',fileName:'Movie One.mp4'}]}}),'Movie One'),100);
  assert.equal(videos.score(video(2,{message:'Movie One'}),'Movie One'),50);
  assert.equal(videos.matches({text:'ABC 123'},'abc123'),true);
  let options;const client={async getMessages(_peer,o){options=o;return[19,20,180,181].map(n=>({id:n,video:{attributes:[{className:'DocumentAttributeVideo',duration:n}]}}));}};
  const found=await videos.channelVideos(client,{className:'Channel',megagroup:true},undefined,'','kkp',()=>false,new Set(),new AbortController().signal);
  assert.deepEqual(found.map(x=>x.id),[20,180]);assert.equal(options.limit,200);assert.equal(options.filter.className,'InputMessagesFilterVideo');
});
test('komari aggregates all nodes and renders hardware, billing and bit rates',async()=>{
  const nodes=Array.from({length:101},(_,i)=>({uuid:String(i),name:'node '+i,cpu_cores:2,cpu_name:'Test CPU',gpu_name:'Test GPU',arch:'arm64',virtualization:'kvm',price:5,billing_cycle:30,currency:'$',auto_renewal:true,expired_at:'2099-01-01'}));
  const requested=[];const api=reports.createReports(async(_base,endpoint)=>{requested.push(endpoint);return{status:'success',data:endpoint==='/api/public'?{sitename:'Test'}:endpoint==='/api/nodes'?nodes:[{cpu:{usage:25},network:{down:128,up:256},load:{load1:1,load5:2,load15:3}}]};});
  const total=await api.getNodesOverview('local');assert.equal(requested.filter(x=>x.startsWith('/api/recent/')).length,101);
  assert.match(total,/101 \/ 101/);assert.match(total,/202/);assert.match(total,/25.00%/);assert.match(total,/101 Kbps/);
  const detail=await api.getNodeDetails('local','node 100');for(const term of ['Test CPU','Test GPU','arm64','kvm','$5 / 30 天','1 Kbps','2 Kbps'])assert.ok(detail.includes(term),term);
});
test('openlist installation saves initial credentials and updates preserve them',async t=>{
  const {buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));
  const create=require(path.join(buildPlugin({id:'openlist',packageRoot:path.resolve(__dirname,'../openlist'),entry:'v2.ts'}).artifactDir,'index.cjs')).default;
  const platform=Object.getOwnPropertyDescriptor(process,'platform');Object.defineProperty(process,'platform',{value:'linux'});t.after(()=>Object.defineProperty(process,'platform',platform));
  let state={schemaVersion:1,username:'',password:'',defaultPath:'',legacyImported:true};const calls=[],edits=[];const signal=new AbortController().signal;
  const ctx={signal,storage:{json:()=>({read:async()=>structuredClone(state),update:async fn=>(state=await fn(state))})},telegram:{edit:async(_m,text)=>edits.push(text)},http:{withResponse:async(_url,_init,fn)=>fn(new Response('test archive'),signal)},files:{withTemp:async fn=>{const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'mibot-openlist-test-'));try{return await fn(dir,signal);}finally{fs.rmSync(dir,{recursive:true,force:true});}}},processes:{run:async(executable,args)=>{calls.push([executable,...args]);return{stdout:Buffer.from(args[0]==='admin'?'username: admin\n':''),stderr:Buffer.from(args[0]==='admin'?'password: fixture-password\n':'')};}}};
  const run=action=>create().commands.op.handle({message:{id:1,chatId:'7',outgoing:true,saved:false},args:[action],prefix:'.'},ctx);
  await run('install');assert.equal(state.username,'admin');assert.equal(state.password,'fixture-password');assert.match(edits.at(-1),/安装完成/);
  const adminIndex=calls.findIndex(x=>x[1]==='admin');assert.ok(adminIndex>calls.findIndex(x=>x.includes('enable')));
  calls.length=0;await run('update');assert.match(edits.at(-1),/更新完成/);assert.ok(calls.every(x=>x[1]!=='admin'));assert.equal(state.password,'fixture-password');assert.ok(edits.every(x=>!x.includes('fixture-password')));
});
