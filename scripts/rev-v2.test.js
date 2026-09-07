'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'rev', packageRoot: path.resolve(__dirname, '../rev'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function fixture(reply) {
  const edits = [], calls = [], sends = [];
  const raw = {peerId: 4, async delete() {}};
  const context = {signal: new AbortController().signal, log: {info() {}, error() {}},
    files: {async withTemp(use) {const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-rev-')); try {return await use(dir, context.signal);} finally {await fs.rm(dir, {recursive: true, force: true});}}},
    processes: {async run(command, args, options) {calls.push({command, args, options}); await fs.writeFile(args.at(-1), 'output'); return {stdout: Buffer.alloc(0)};}},
    telegram: {async edit(message, text, options) {edits.push({message, text, options});}, async getReply() {return reply;},
      async withClient(operation) {return operation({async downloadMedia(media, options) {await fs.writeFile(options.outputFile, 'input');}, async sendFile(peer, value) {sends.push({peer, value});}}, context.signal);}},
  };
  return {edits, calls, sends, run: (text, message = {}) => create().commands.rev.handle({command: 'rev', prefix: '.', args: text.split(/\s+/).slice(1), message: {id: 1, chatId: '4', outgoing: true, text, raw, ...message}}, context)};
}

test('rev reverses each line without splitting emoji graphemes', async () => {
  const f = fixture();
  await f.run('.rev A👨‍👩‍👧‍👦B');
  assert.equal(f.edits.at(-1).text, 'B👨‍👩‍👧‍👦A');
});

test('rev sends fixed ffmpeg filters for replied media', async () => {
  const f = fixture({text: 'caption', raw: {media: {}, photo: {}}});
  await f.run('.rev v c', {replyToId: 8});
  assert.equal(f.calls[0].command, '/usr/bin/ffmpeg');
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['-nostdin', '-y', '-i']);
  assert.equal(f.calls[0].args.includes('vflip,negate'), true);
  assert.equal(f.sends[0].value.caption, 'noitpac');
});

test('rev shows local help for missing input', async () => {
  const f = fixture();
  await f.run('.rev');
  assert.equal(f.calls.length, 0);
  assert.match(f.edits.at(-1).text, /内容反转/);
});
