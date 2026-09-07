'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'copy_sticker_set', packageRoot: path.resolve(__dirname, '../copy_sticker_set'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));

function fixture() {
  const edits = [], calls = [];
  const document = Object.create(Api.Document.prototype);
  Object.assign(document, {id: 1n, accessHash: 2n, fileReference: Buffer.from('ref'),
    attributes: [Object.assign(Object.create(Api.DocumentAttributeSticker.prototype), {alt: '😀'})]});
  const context = {signal: new AbortController().signal, log: {info() {}, error() {}}, telegram: {
    async edit(message, text, options) {edits.push({message, text, options});},
    async withClient(operation) {return operation({async invoke(request) {
      calls.push(request);
      if (calls.length === 1) return {set: {title: '<Original>'}, documents: [document]};
      return {set: {title: 'copy'}, documents: [document]};
    }}, context.signal);},
  }};
  return {edits, calls, run: text => create().commands.css.handle({command: 'css', prefix: '.', args: text.split(/\s+/).slice(1), message: {id: 1, chatId: '1', outgoing: true, text}}, context)};
}

test('copy_sticker_set accepts Telegram links, applies limits, and creates a set', async () => {
  const f = fixture();
  await f.run('.css https://t.me/addstickers/source My Set limit=1');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].stickerset.shortName, 'source');
  assert.equal(f.calls[1].title, 'My Set');
  assert.equal(f.calls[1].stickers.length, 1);
  assert.ok(f.calls[1].shortName.length <= 64);
  assert.match(f.edits.at(-1).text, /&lt;Original&gt;[\s\S]*打开新贴纸包/);
});

test('copy_sticker_set rejects malformed names and limits before Telegram access', async () => {
  for (const text of ['.css https://evil.test/addstickers/a', '.css bad-name', '.css valid limit=121']) {
    const f = fixture();
    await f.run(text);
    assert.equal(f.calls.length, 0);
    assert.match(f.edits.at(-1).text, /复制贴纸包/);
  }
});
