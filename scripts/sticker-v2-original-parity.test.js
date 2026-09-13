'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const Utils = require(path.join(core, 'node_modules/teleproto/Utils.js'));
const {artifactDir} = buildPlugin({id: 'sticker', packageRoot: path.resolve(__dirname, '../sticker'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function sticker() {
  const attribute = Object.assign(Object.create(Api.DocumentAttributeSticker.prototype), {alt: '😀', stickerset: new Api.InputStickerSetEmpty()});
  return Object.assign(Object.create(Api.Document.prototype), {id: 1n, accessHash: 2n, fileReference: Buffer.from('ref'),
    mimeType: 'image/webp', attributes: [attribute]});
}

test('sticker bot serialization state belongs to each factory instance', async () => {
  let active = 0, peak = 0;
  const make = (plugin = create()) => {
    let data = {schemaVersion: 1, sticker_default_pack: 'Existing'};
    let next = 100;
    const history = [{id: 100, date: Math.floor(Date.now() / 1000), out: false, message: 'Thanks! Now send me an emoji'}];
    const client = {
      async getMe() { return {username: 'tester'}; },
      async invoke(request) { if (request instanceof Api.messages.GetStickerSet) return {set: {count: 1}}; return {}; },
      async getMessages() { return history.slice().reverse(); },
      async sendMessage(_peer, options) {
        active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active -= 1;
        const response = options.message === '/addsticker' ? 'choose pack' : options.message === 'Existing' ? 'send sticker'
          : options.message === '😀' ? 'done' : 'ok';
        history.push({id: ++next, date: Math.floor(Date.now() / 1000), out: false, message: response});
      },
      async forwardMessages() {
        active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active -= 1;
        history.push({id: ++next, date: Math.floor(Date.now() / 1000), out: false, message: 'Thanks! Now send me an emoji'});
      },
    };
    const source = {id: 44, peerId: 'peer', sticker: sticker(), media: {}};
    const controller = new AbortController();
    const context = {signal: controller.signal, log: {error() {}}, storage: {json() { return {
      async read() { return structuredClone(data); }, async update(operation) { data = await operation(structuredClone(data)); return data; },
    }; }}, telegram: {async edit() {}, async getReply() { return {raw: source}; },
      async withClient(operation) { return operation(client, controller.signal); }}};
    return {plugin, controller, history, run: () => plugin.commands.sticker.handle({command: 'sticker', prefix: '.', args: [],
      message: {id: 1, chatId: '1', outgoing: true, text: '.sticker', replyToId: 44, raw: {peerId: 'peer'}}}, context)};
  };
  const first = make(), second = make();
  await Promise.all([first.run(), second.run()]);
  assert.equal(peak, 2);
  await first.plugin.cleanup();
  await second.plugin.cleanup();
  active = 0; peak = 0;
  const shared = create(), one = make(shared);
  await Promise.all([one.run(), one.run()]);
  assert.equal(peak, 1, 'one plugin instance serializes @Stickers conversations');
  await shared.cleanup(); const cancelPlugin=create(), queued = make(cancelPlugin), blocker = make(cancelPlugin); const firstRun = blocker.run(); await new Promise(resolve=>setTimeout(resolve,1)); const queuedRun = queued.run(); queued.controller.abort(new Error('cancel queued'));
  await Promise.allSettled([firstRun, queuedRun]);
  assert.equal(queued.history.length, 1, 'cancelled queued work never starts a bot conversation beyond baseline');
  await cancelPlugin.cleanup();
});

test('cancelling a pending bot history read sends no next conversation step',async()=>{const controller=new AbortController(),sent=[];let release,reads=0;const pending=new Promise(r=>{release=r;}),source={id:44,peerId:'peer',sticker:sticker()};const client={async getMe(){return{username:'tester'};},async invoke(request){if(request instanceof Api.messages.GetStickerSet)return{set:{count:1}};return{};},async getMessages(){if(++reads===1)return[];return pending;},async sendMessage(_peer,value){sent.push(value.message);},async forwardMessages(){assert.fail('cancelled history must not advance');}};const context={signal:controller.signal,log:{error(){}},storage:{json:()=>({async read(){return{schemaVersion:1,sticker_default_pack:'Existing'};},async update(v){return v;}})},telegram:{async edit(){},async getReply(){return{raw:source};},async withClient(op){return op(client,controller.signal);}}};const running=create().commands.sticker.handle({command:'sticker',prefix:'.',args:[],message:{id:1,chatId:'1',outgoing:true,text:'.sticker',replyToId:44,raw:{peerId:'peer'}}},context);while(sent.length===0)await new Promise(r=>setTimeout(r,1));controller.abort();release([{id:101,date:Math.floor(Date.now()/1000),out:false,message:'choose'}]);await running;assert.deepEqual(sent,['/addsticker']);});

test('real sticker-set requests resolve and serialize, and receipt failure stays separate',async()=>{const controller=new AbortController(),calls=[],logs=[],source={id:44,peerId:new Api.PeerChannel({channelId:100n}),sticker:sticker()};const client={async getMe(){return Object.assign(Object.create(Api.User.prototype),{id:1n,username:'tester'});},async getInputEntity(value){if(value==='me')return new Api.InputUserSelf();return value;},async invoke(request){calls.push(request);if(request instanceof Api.messages.GetStickerSet)throw Object.assign(new Error('missing'),{errorMessage:'STICKERSET_INVALID'});return{};}};const context={signal:controller.signal,log:{error:event=>logs.push(event)},storage:{json:()=>({async read(){return{schemaVersion:1,sticker_default_pack:'NewPack'};},async update(v){return v;}})},telegram:{async edit(){throw new Error('receipt');},async getReply(){return{raw:source};},async withClient(op){return op(client,controller.signal);}}};await create().commands.sticker.handle({command:'sticker',prefix:'.',args:[],message:{id:1,chatId:'1',outgoing:true,text:'.sticker',replyToId:44,raw:{peerId:'peer'}}},context);const get=calls.find(x=>x instanceof Api.messages.GetStickerSet),created=calls.find(x=>x instanceof Api.stickers.CreateStickerSet);await get.resolve(client,Utils);await created.resolve(client,Utils);assert.ok(get.getBytes().length>0);assert.ok(created.getBytes().length>0);assert.deepEqual(logs,['sticker_completion_receipt_failed']);});
