'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const {returnBigInt} = require(path.join(core, 'node_modules/teleproto/Helpers'));
const sharp = require(path.join(core, 'node_modules/sharp'));
const {artifactDir} = buildPlugin({id: 'yvlu-sticker-test', packageRoot: path.resolve(__dirname, '../yvlu'), entry: 'v2/stickers.ts'});
const {saveSticker} = require(path.join(artifactDir, 'index.cjs'));

function document(attributes = []) { return new Api.Document({id: returnBigInt('9007199254740993'), accessHash: returnBigInt('9007199254740995'),
  fileReference: Buffer.from([1, 2]), date: 1, mimeType: 'image/webp', size: returnBigInt(4), dcId: 2, attributes}); }
function existingSet() { return new Api.messages.StickerSet({set: new Api.StickerSet({id: 1n, accessHash: 2n, title: 'set', shortName: 'set', count: 1, hash: 0}), packs: [], keywords: [], documents: []}); }
function contextFor(raw, invoke, uploadFile) {
  const signal = new AbortController().signal;
  return {signal, telegram: {async getReply() {return {id: 2, chatId: '1', text: '', outgoing: false, raw};},
    async withClient(operation) {return operation({invoke, uploadFile, async getMe() {return new Api.User({id: 3n, firstName: 'Me'});},
      async downloadMedia(_target, options) {return options.testImage;}}, signal);}}, files: {async withTemp(use) {return use('/tmp', signal);}}};
}

test('existing sticker reuses its exact InputDocument and serializes AddStickerToSet', async () => {
  const doc = document([new Api.DocumentAttributeSticker({alt: '🙂', stickerset: new Api.InputStickerSetEmpty()})]);
  const calls = [], ctx = contextFor({media: new Api.MessageMediaDocument({document: doc})}, async request => {
    calls.push(request); request.getBytes(); if (request instanceof Api.messages.GetStickerSet) return existingSet(); return true;
  });
  assert.equal(await saveSticker(ctx, {id: 1, chatId: '1', text: '', outgoing: true}, 'set'), false);
  const add = calls.find(value => value instanceof Api.stickers.AddStickerToSet); assert.ok(add); add.getBytes();
  assert.equal(String(add.sticker.document.id), '9007199254740993');
  assert.equal(String(add.sticker.document.accessHash), '9007199254740995');
  assert.deepEqual(add.sticker.document.fileReference, Buffer.from([1, 2]));
});

test('photo uploads to a document then serializes CreateStickerSet when the set is absent', async () => {
  const png = await sharp({create: {width: 8, height: 6, channels: 4, background: '#abc'}}).png().toBuffer();
  const uploaded = new Api.InputFile({id: 4n, parts: 1, name: 'sticker.png', md5Checksum: 'x'}), uploadedDoc = document();
  const calls = [];
  const ctx = contextFor({media: new Api.MessageMediaPhoto({})}, async request => {
    calls.push(request); request.getBytes();
    if (request instanceof Api.messages.GetStickerSet) throw {errorMessage: 'STICKERSET_INVALID'};
    if (request instanceof Api.messages.UploadMedia) return new Api.MessageMediaDocument({document: uploadedDoc});
    return true;
  }, async options => {options.file; return uploaded;});
  ctx.telegram.withClient = async operation => operation({
    invoke: ctxInvoke, uploadFile: async options => {options.file; return uploaded;}, async getMe() {return new Api.User({id: 3n, firstName: 'Me'});},
    async downloadMedia(_target, options) {options.progressCallback(returnBigInt(png.length), returnBigInt(png.length)); return png;}
  }, ctx.signal);
  async function ctxInvoke(request) {calls.push(request); request.getBytes(); if (request instanceof Api.messages.GetStickerSet) throw {errorMessage: 'STICKERSET_INVALID'}; if (request instanceof Api.messages.UploadMedia) return new Api.MessageMediaDocument({document: uploadedDoc}); return true;}
  assert.equal(await saveSticker(ctx, {id: 1, chatId: '1', text: '', outgoing: true}, 'new_set'), true);
  assert.ok(calls.some(value => value instanceof Api.messages.UploadMedia));
  const create = calls.find(value => value instanceof Api.stickers.CreateStickerSet); assert.ok(create); create.getBytes();
  assert.equal(String(create.stickers[0].document.id), '9007199254740993');
});
