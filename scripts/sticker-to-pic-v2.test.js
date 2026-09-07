'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'sticker_to_pic', packageRoot: path.resolve(__dirname, '../sticker_to_pic'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));

function sticker() {
  const document = Object.assign(Object.create(Api.Document.prototype), {mimeType: 'image/webp',
    attributes: [Object.create(Api.DocumentAttributeSticker.prototype)]});
  return {media: {}, document};
}

function fixture() {
  const edits = [], calls = [], sends = [];
  const raw = {peerId: 5, async delete() {}};
  const context = {signal: new AbortController().signal, log: {info() {}, error() {}},
    files: {async withTemp(use) {const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-stp-')); try {return await use(dir, context.signal);} finally {await fs.rm(dir, {recursive: true, force: true});}}},
    processes: {async run(command, args, options) {calls.push({command, args, options}); await fs.writeFile(args.at(-1), 'picture'); return {stdout: Buffer.from('ImageMagick 7')};}},
    telegram: {async edit(message, text, options) {edits.push({message, text, options});}, async getReply() {return {raw: sticker()};},
      async withClient(operation) {return operation({async downloadMedia(media, options) {await fs.writeFile(options.outputFile, 'webp');}, async sendFile(peer, value) {sends.push({peer, value});}}, context.signal);}},
  };
  return {edits, calls, sends, run: (text, message = {}) => create().commands.stp.handle({command: 'stp', prefix: '.', args: text.split(/\s+/).slice(1), message: {id: 1, chatId: '5', outgoing: true, text, raw, replyToId: 9, ...message}}, context)};
}

test('sticker_to_pic converts transparent PNG in a scoped temporary directory', async () => {
  const f = fixture();
  await f.run('.stp transparent');
  assert.equal(f.calls[0].command, '/usr/bin/magick');
  assert.equal(f.calls[0].args.at(-1).endsWith('.png'), true);
  assert.equal(f.calls[0].args.includes('-background'), false);
  assert.equal(f.sends[0].value.forceDocument, false);
});

test('sticker_to_pic uses flattening args and document mode', async () => {
  const f = fixture();
  await f.run('.stp doc');
  assert.deepEqual(f.calls[0].args.slice(1, -1), ['-background', 'white', '-alpha', 'remove', '-alpha', 'off']);
  assert.equal(f.sends[0].value.forceDocument, true);
});

test('sticker_to_pic rejects unknown options before media access', async () => {
  const f = fixture();
  await f.run('.stp nope');
  assert.equal(f.calls.length, 0);
  assert.match(f.edits.at(-1).text, /贴纸转图片/);
});
