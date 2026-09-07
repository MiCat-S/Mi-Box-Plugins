'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'qr', packageRoot: path.resolve(__dirname, '../qr'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function fixture(options = {}) {
  const edits = [], calls = [], sends = [], deleted = [];
  const raw = {peerId: 9, async delete(value) { deleted.push(value); }};
  const context = {signal: new AbortController().signal, log: {info() {}, error() {}},
    files: {async withTemp(use) {const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-qr-')); try {return await use(dir, context.signal);} finally {await fs.rm(dir, {recursive: true, force: true});}}},
    processes: {async run(command, args, runOptions) {calls.push({command, args, runOptions}); if (options.processFail) throw new Error('private'); return {stdout: Buffer.from(options.stdout ?? 'PNG')};}},
    telegram: {async edit(message, text, editOptions) {edits.push({message, text, editOptions});}, async reply() {}, async invoke() {},
      async getReply() {return options.reply;}, async withClient(operation) {return operation({
        async sendFile(peer, value) {sends.push({peer, value});}, async downloadMedia() {return Buffer.from('image');},
      }, context.signal);}},
  };
  return {edits, calls, sends, deleted, run: (text, message = {}) => create().commands.qr.handle({command: 'qr', prefix: '.', args: text.split(/\s+/).slice(1), message: {id: 1, chatId: '9', outgoing: true, text, raw, ...message}}, context)};
}

test('qr generates through an argv-only bounded helper and sends the image', async () => {
  const f = fixture();
  await f.run('.qr hello; rm -rf /');
  assert.deepEqual(f.calls[0].args.slice(-2), ['--', 'hello; rm -rf /']);
  assert.equal(f.calls[0].command, '/usr/bin/qrencode');
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.deleted, [{revoke: true}]);
});

test('qr decodes replied media and escapes every result', async () => {
  const f = fixture({reply: {text: '', raw: {media: {}, photo: {}}}, stdout: '<value>&\nsecond'});
  await f.run('.qr', {replyToId: 3});
  assert.equal(f.calls[0].command, '/usr/bin/zbarimg');
  assert.match(f.edits.at(-1).text, /&lt;value&gt;&amp;[\s\S]*second/);
  assert.equal(f.edits.at(-1).editOptions.parseMode, 'html');
});

test('qr validates oversized text and hides process errors', async () => {
  const f = fixture({processFail: true});
  await f.run(`.qr ${'x'.repeat(4001)}`);
  assert.equal(f.calls.length, 0);
  assert.match(f.edits.at(-1).text, /二维码操作失败/);
  assert.doesNotMatch(f.edits.at(-1).text, /private/);
});
