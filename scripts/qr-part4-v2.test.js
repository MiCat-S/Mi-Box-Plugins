'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const create = require(path.join(buildPlugin({id: 'qr', packageRoot: path.resolve(__dirname, '../qr'), entry: 'v2.ts'}).artifactDir, 'index.cjs')).default;

function fixture(t, options = {}) {
  const edits = [], replies = [], sends = [], errors = [];
  const signal = new AbortController().signal;
  const raw = {peerId: 'peer', async delete() {if (options.deleteFails) throw new Error('delete failed');}};
  const client = {async *iterDownload() {yield Buffer.from('image');}, async sendFile(_peer, value) {sends.push(value);}};
  const context = {signal, log: {error(event) {errors.push(event);}}, files: {async withTemp(operation) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-part4-')); try {return await operation(directory, signal);} finally {await fs.rm(directory, {recursive: true, force: true});}
  }}, processes: {async run(command) {return {stdout: Buffer.from(command.includes('zbarimg') ? options.decoded ?? '' : 'PNG'), stderr: Buffer.alloc(0), exitCode: 0};}},
  telegram: {async edit(_message, text) {edits.push(text);}, async reply(_message, text) {replies.push(text);}, async getReply() {return options.reply;},
    async withClient(operation) {return operation(client, signal);}}};
  const run = args => create().commands.qr.handle({command: 'qr', prefix: '.', args,
    message: {id: 1, chatId: '1', replyToId: options.reply ? 2 : undefined, text: `.qr ${args.join(' ')}`, outgoing: true, raw}}, context);
  return {run, edits, replies, sends, errors};
}

test('qr preserves decoded leading and trailing spaces and paginates escaped output', async t => {
  const long = '<'.repeat(3400);
  const f = fixture(t, {reply: {raw: {media: {}, photo: {}}}, decoded: `  padded  \n${long}\n`});
  await f.run([]);
  assert.match(f.edits.at(-1), /<code>  padded  <\/code>/);
  assert.ok(f.replies.length > 0);
  assert.ok([f.edits.at(-1), ...f.replies].every(value => value.length <= 3500));
  assert.ok([f.edits.at(-1), ...f.replies].join('').includes('&lt;'));
});

test('qr keeps a successful send when command cleanup fails', async t => {
  const f = fixture(t, {deleteFails: true});
  await f.run(['payload']);
  assert.equal(f.sends.length, 1);
  assert.ok(f.errors.includes('qr_command_cleanup_failed'));
  assert.doesNotMatch(f.edits.at(-1) || '', /二维码操作失败/);
});
