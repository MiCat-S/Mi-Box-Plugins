'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const {artifactDir} = buildPlugin({id: 'sticker', packageRoot: path.resolve(__dirname, '../sticker'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function sticker() {
  const attribute = Object.assign(Object.create(Api.DocumentAttributeSticker.prototype), {alt: '😀', stickerset: new Api.InputStickerSetEmpty()});
  return Object.assign(Object.create(Api.Document.prototype), {id: 1n, accessHash: 2n, fileReference: Buffer.from('ref'),
    mimeType: 'image/webp', attributes: [attribute]});
}

test('sticker bot serialization state belongs to each factory instance', async () => {
  let active = 0, peak = 0;
  const make = () => {
    let data = {schemaVersion: 1, sticker_default_pack: 'Existing'};
    let next = 100;
    const history = [];
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
    const plugin = create();
    return {plugin, run: () => plugin.commands.sticker.handle({command: 'sticker', prefix: '.', args: [],
      message: {id: 1, chatId: '1', outgoing: true, text: '.sticker', replyToId: 44, raw: {peerId: 'peer'}}}, context)};
  };
  const first = make(), second = make();
  await Promise.all([first.run(), second.run()]);
  assert.equal(peak, 2);
  await first.plugin.cleanup();
  await second.plugin.cleanup();
});
