'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'copy_sticker_set', packageRoot: path.resolve(__dirname, '../copy_sticker_set'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const Utils = require(path.join(core, 'node_modules/teleproto/Utils.js'));

test('copy_sticker_set bounds the generated title and serializes exact document ids', async () => {
  const documentId = 922337203685477000n;
  const accessHash = 812337203685477001n;
  const document = new Api.Document({
    id: documentId,
    accessHash,
    fileReference: Buffer.from('document-reference'),
    date: 0,
    mimeType: 'image/webp',
    size: 100n,
    dcId: 1,
    attributes: [new Api.DocumentAttributeSticker({alt: '🙂', stickerset: new Api.InputStickerSetEmpty()})],
  });
  const calls = [];
  const client = {
    async getInputEntity(value) {
      assert.equal(value, 'me');
      return new Api.InputUserSelf();
    },
    async invoke(request) {
      calls.push(request);
      if (request instanceof Api.messages.GetStickerSet) {
        return {set: {title: '甲'.repeat(64)}, documents: [document]};
      }
      return {};
    },
  };
  const signal = new AbortController().signal;
  const context = {
    signal,
    log: {error() {}},
    telegram: {async edit() {}, async withClient(operation) {return operation(client, signal);}},
  };
  await create().commands.copy_sticker_set.handle({
    command: 'copy_sticker_set', prefix: '.', args: ['source'],
    message: {id: 1, chatId: '1', outgoing: true, text: '.copy_sticker_set source'},
  }, context);

  const request = calls.find(value => value instanceof Api.stickers.CreateStickerSet);
  assert.ok(request);
  assert.equal(Array.from(request.title).length, 64);
  assert.equal(request.stickers[0].document.id, documentId);
  assert.equal(request.stickers[0].document.accessHash, accessHash);
  await request.resolve(client, Utils);
  assert.ok(request.userId instanceof Api.InputUserSelf);
  assert.ok(request.getBytes().length > 0);
  assert.equal(request.stickers[0].document.id.toString(), '922337203685477000');
});
