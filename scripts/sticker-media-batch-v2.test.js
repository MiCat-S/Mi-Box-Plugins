'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fsSync=require('node:fs');
const fs=require('node:fs/promises');
const Module=require('node:module');
const os=require('node:os');
const path=require('node:path');
const {inflateRawSync}=require('node:zlib');
const core=path.resolve(__dirname,'../../TeleBox-Core');
const {buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));
const {PluginHost}=require(path.join(core,'dist/v2/host.js'));
const {Api}=require(path.join(core,'node_modules/teleproto'));
const sharp=require(path.join(core,'node_modules/sharp'));

const runtimeProcesses={concurrency:2,queueCapacity:16,timeoutMs:180000,maxOutputBytes:2*1024*1024};

function artifact(id){const built=buildPlugin({id,packageRoot:path.resolve(__dirname,`../${id}`),entry:'v2.ts'});return{built,create:require(path.join(built.artifactDir,'index.cjs')).default};}
const plugins=Object.fromEntries(['sticker','pic_to_sticker','getstickers'].map(id=>[id,artifact(id)]));
function getStickersCreateArchive(){
  const filename=path.join(plugins.getstickers.built.artifactDir,'index.cjs'),candidate=new Module(filename);
  candidate.filename=filename;candidate.paths=Module._nodeModulePaths(path.dirname(filename));
  candidate._compile(`${fsSync.readFileSync(filename,'utf8')}\nmodule.exports.__createArchive=createArchive;`,filename);
  return candidate.exports.__createArchive;
}
async function settlesWithin(promise,timeoutMs=1000){
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`operation did not settle within ${timeoutMs}ms`)),timeoutMs);})]);}finally{clearTimeout(timer);}
}
function document(mime='image/webp',set='pack_one'){
  return Object.assign(Object.create(Api.Document.prototype),{id:1n,accessHash:2n,fileReference:Buffer.from('ref'),mimeType:mime,
    attributes:[Object.assign(Object.create(Api.DocumentAttributeSticker.prototype),{alt:'😀',stickerset:new Api.InputStickerSetShortName({shortName:set})})]});
}
function zipFiles(buffer){
  const eocd=buffer.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));assert.notEqual(eocd,-1,'ZIP end record');
  const count=buffer.readUInt16LE(eocd+10),files=new Map();let central=buffer.readUInt32LE(eocd+16);
  for(let index=0;index<count;index++){
    assert.equal(buffer.readUInt32LE(central),0x02014b50,'ZIP central entry');
    const method=buffer.readUInt16LE(central+10),compressedSize=buffer.readUInt32LE(central+20),nameLength=buffer.readUInt16LE(central+28),extraLength=buffer.readUInt16LE(central+30),commentLength=buffer.readUInt16LE(central+32),local=buffer.readUInt32LE(central+42);
    const name=buffer.subarray(central+46,central+46+nameLength).toString('utf8');assert.equal(buffer.readUInt32LE(local),0x04034b50,'ZIP local entry');
    const dataStart=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28),compressed=buffer.subarray(dataStart,dataStart+compressedSize);
    files.set(name,method===0?Buffer.from(compressed):method===8?inflateRawSync(compressed):assert.fail(`unsupported ZIP method ${method}`));
    central+=46+nameLength+extraLength+commentLength;
  }
  return files;
}
function memoryStorage(initial={}){const values=structuredClone(initial);let tail=Promise.resolve();return{values,json(name,defaults){return{async read(){await tail;return structuredClone(values[name]??defaults);},async update(fn){const result=tail.then(async()=>{values[name]=await fn(structuredClone(values[name]??defaults));return structuredClone(values[name]);});tail=result.then(()=>undefined,()=>undefined);return result;}};}};}
function directContext(options={}){
  const controller=new AbortController(),edits=[],sent=[],calls=[],storage=memoryStorage(options.storage);
  const suppliedClient=options.client??{};const client={...suppliedClient,async sendFile(peer,value){sent.push({peer,value});return suppliedClient.sendFile?suppliedClient.sendFile(peer,value):{id:99};}};
  return{controller,edits,sent,calls,storage,client,context:{signal:controller.signal,log:{info(){},error(event,fields){calls.push({event,fields});}},storage,
    telegram:{async edit(message,text,settings){edits.push({message,text,settings});},async reply(){},async getReply(){return options.reply;},async withClient(fn){return fn(client,controller.signal);}},
    files:options.files??{},processes:options.processes??{},jobs:{},services:{},commands:{parse(){}}}};
}

test('sticker migrates the flat legacy config and creates an unavailable configured pack directly',async()=>{
  const source={id:44,peerId:'peer',sticker:document(),media:{}};
  const f=directContext({storage:{'config.json':{sticker_default_pack:'My_Pack'}},reply:{raw:source},client:{async getMe(){return Object.assign(Object.create(Api.User.prototype),{username:'tester'});},async invoke(request){f.calls.push(request);if(request instanceof Api.messages.GetStickerSet)throw Object.assign(new Error('missing'),{errorMessage:'STICKERSET_INVALID'});return{};}}});
  const plugin=plugins.sticker.create();await plugin.commands.sticker.handle({command:'sticker',prefix:'.',args:[],message:{id:1,chatId:'1',text:'.sticker',outgoing:true,replyToId:44,raw:{peerId:'peer'}}},f.context);
  assert.equal(f.storage.values['config.json'].schemaVersion,1);assert.ok(f.calls.some(value=>value instanceof Api.stickers.CreateStickerSet));assert.match(f.edits.at(-1).text,/My_Pack/);
});

test('sticker serializes and correlates @Stickers replies by monotonically newer ids',async()=>{
  const source={id:44,peerId:'peer',sticker:document(),media:{}};let next=100;const messages=[];let active=0,peak=0;
  const client={async getMe(){return Object.assign(Object.create(Api.User.prototype),{username:'tester'});},async invoke(request){if(request instanceof Api.messages.GetStickerSet)return{set:{count:1}};return{};},
    async getMessages(){return messages.slice(-8).reverse();},async sendMessage(peer,value){active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));messages.push({id:++next,date:Math.floor(Date.now()/1000),out:false,message:value.message==='/addsticker'?'choose':value.message==='Existing'?'send sticker':value.message==='😀'?'done':'ok'});active--;},
    async forwardMessages(){messages.push({id:++next,date:Math.floor(Date.now()/1000),out:false,message:'Thanks! Now send me an emoji'});}};
  const make=()=>directContext({storage:{'config.json':{schemaVersion:1,sticker_default_pack:'Existing'}},reply:{raw:source},client});const a=make(),b=make(),plugin=plugins.sticker.create();
  await Promise.all([a,b].map(f=>plugin.commands.sticker.handle({command:'sticker',prefix:'.',args:[],message:{id:1,chatId:'1',text:'.sticker',outgoing:true,replyToId:44,raw:{peerId:'peer'}}},f.context)));
  assert.equal(peak,1);assert.match(a.edits.at(-1).text,/Existing/);assert.match(b.edits.at(-1).text,/Existing/);
});

test('pic_to_sticker preserves legacy settings and streams a valid image through sharp',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pts-v2-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const png=await sharp({create:{width:2,height:2,channels:4,background:{r:255,g:0,b:0,alpha:1}}}).png().toBuffer();
  const source={id:3,peerId:'peer',media:{},photo:{}};const files={async withTemp(fn){const dir=await fs.mkdtemp(path.join(root,'tmp-'));try{return await fn(dir,new AbortController().signal);}finally{await fs.rm(dir,{recursive:true,force:true});}}};
  const f=directContext({storage:{'config.json':{defaultEmoji:'🔥',quality:80,size:512,background:'transparent',autoDelete:false,compressionLevel:6}},reply:{raw:source},files,
    client:{async *iterDownload(){yield png;},async sendFile(peer,value){assert.ok((await fs.stat(value.file)).size>0);}}});
  const plugin=plugins.pic_to_sticker.create();await plugin.commands.pts.handle({command:'pts',prefix:'.',args:[],message:{id:1,chatId:'1',text:'.pts',outgoing:true,replyToId:3,raw:{peerId:'peer'}}},f.context);
  assert.equal(f.storage.values['config.json'].schemaVersion,1);assert.equal(f.sent.length,1);assert.equal(f.sent[0].value.attributes[0].alt,'🔥');assert.match(f.edits.at(-1).text,/贴纸已发送/);
});

test('getstickers streams a real archive and keeps it until sending settles',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'getstickers-v2-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const doc=document();const reply={raw:{id:3,peerId:'peer',media:{document:doc}}};const calls=[];let archivePath,archiveBytes,startSend,finishSend;
  const sending=new Promise(resolve=>{startSend=resolve;}),releaseSend=new Promise(resolve=>{finishSend=resolve;});
  const files={async withTemp(fn){const dir=await fs.mkdtemp(path.join(root,'tmp-'));try{return await fn(dir,new AbortController().signal);}finally{await fs.rm(dir,{recursive:true,force:true});}}};
  const processes={async run(command,args,settings){calls.push({command,args,settings});await fs.writeFile(args.at(-1),Buffer.from('GIF89a'));return{stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),exitCode:0};}};
  const f=directContext({reply,files,processes,client:{async invoke(){return{set:{shortName:'pack_one'},documents:[doc],packs:[{emoticon:'😀',documents:[1n]}]};},async downloadFile(location,{outputFile}){await fs.writeFile(outputFile,Buffer.from('RIFF'));},async sendFile(peer,value){assert.match(value.file,/pack_one\.zip$/);archivePath=value.file;archiveBytes=await fs.readFile(value.file);startSend();await releaseSend;assert.ok((await fs.stat(value.file)).isFile());}}});
  const plugin=plugins.getstickers.create(),running=plugin.commands.getstickers.handle({command:'getstickers',prefix:'.',args:[],message:{id:1,chatId:'1',text:'.getstickers',outgoing:true,replyToId:3,raw:{peerId:'peer'}}},f.context);
  assert.equal(await Promise.race([sending.then(()=>true),running.then(()=>false)]),true,JSON.stringify(f.calls));assert.ok((await fs.stat(archivePath)).isFile());finishSend();await running;await assert.rejects(fs.stat(archivePath),{code:'ENOENT'});
  const zipped=zipFiles(archiveBytes);assert.deepEqual([...zipped.keys()].sort(),['000.gif','pack.txt']);assert.equal(zipped.get('000.gif').toString(),'GIF89a');assert.deepEqual(JSON.parse(zipped.get('pack.txt').toString().trim()),{image_file:'000.gif',emojis:'😀'});
  assert.equal(f.sent.length,1);assert.ok(calls.some(call=>call.command.endsWith('/ffmpeg')));assert.ok(!calls.some(call=>call.command.endsWith('/zip')));
  assert.equal(plugins.getstickers.create().resources.processes.timeoutMs,180000);
});

test('getstickers archive output errors settle promptly',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'getstickers-output-error-v2-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'pack'),target=path.join(root,'pack.zip');await fs.mkdir(source);await fs.writeFile(path.join(source,'pack.txt'),'entry\n');await fs.writeFile(target,'occupied');
  await assert.rejects(settlesWithin(getStickersCreateArchive()(source,target,new AbortController().signal)),error=>error?.code==='EEXIST');
});

test('getstickers archive read errors settle promptly',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'getstickers-read-error-v2-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'pack'),target=path.join(root,'pack.zip'),media=path.join(source,'000.gif');await fs.mkdir(source);await fs.writeFile(media,'GIF89a');await fs.chmod(media,0);
  await assert.rejects(settlesWithin(getStickersCreateArchive()(source,target,new AbortController().signal)),error=>error?.code==='EACCES');
});

test('getstickers archive cancellation settles promptly',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'getstickers-cancel-v2-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'pack'),target=path.join(root,'pack.zip'),controller=new AbortController(),reason=new Error('archive cancelled by test');await fs.mkdir(source);await fs.writeFile(path.join(source,'000.gif'),Buffer.alloc(1024*1024,1));
  const running=getStickersCreateArchive()(source,target,controller.signal);controller.abort(reason);
  await assert.rejects(settlesWithin(running),error=>error===reason);
});

test('getstickers accepts sticker and document media on the command message itself',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'getstickers-own-v2-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const field of ['sticker','document']){const doc=document(),files={async withTemp(fn){const dir=await fs.mkdtemp(path.join(root,'tmp-'));try{return await fn(dir,new AbortController().signal);}finally{await fs.rm(dir,{recursive:true,force:true});}}},processes={async run(_command,args){await fs.writeFile(args.at(-1),Buffer.from('GIF89a'));return{stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),exitCode:0};}};
    const f=directContext({files,processes,client:{async invoke(){return{set:{shortName:`own_${field}`},documents:[doc],packs:[]};},async downloadFile(_location,{outputFile}){await fs.writeFile(outputFile,Buffer.from('RIFF'));}}});
    const plugin=plugins.getstickers.create();await plugin.commands.getstickers.handle({command:'getstickers',prefix:'.',args:[],message:{id:1,chatId:'1',text:'.getstickers',outgoing:true,raw:{peerId:'peer',[field]:doc}}},f.context);assert.equal(f.sent.length,1);
  }
});

test('all sticker media artifacts load, unload and reload through PluginHost',async t=>{
  for(const id of Object.keys(plugins)){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),`sticker-host-${id}-`));
    const host=new PluginHost({storageRoot:root,processes:runtimeProcesses,logger:{info(){},error(){}},telegram:{async edit(){},async reply(){},async invoke(){},async getReply(){},async withClient(fn,signal){return fn({},signal);}}});
    await host.load(plugins[id].create());assert.equal((await host.unload(id,2000)).completed,true);await host.load(plugins[id].create());assert.equal((await host.shutdown(2000)).completed,true);await fs.rm(root,{recursive:true,force:true});
  }t.assert.ok(true);
});

test('default PluginHost rejects getstickers process budget without retaining resources',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sticker-host-budget-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const host=new PluginHost({storageRoot:root,logger:{info(){},error(){}},telegram:{async edit(){},async reply(){},async invoke(){},async getReply(){},async withClient(fn,signal){return fn({},signal);}}});
  await assert.rejects(host.load(plugins.getstickers.create()),/process timeoutMs exceeds host limit/);
  assert.deepEqual(host.listPlugins(),[]);assert.deepEqual(host.listCommands(),[]);assert.equal(host.snapshot().processes,undefined);
  assert.equal((await host.shutdown(2000)).completed,true);
});
