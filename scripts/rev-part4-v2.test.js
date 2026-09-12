'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const create = require(path.join(buildPlugin({id: 'rev', packageRoot: path.resolve(__dirname, '../rev'), entry: 'v2.ts'}).artifactDir, 'index.cjs')).default;

test('rev streams media, gives h its legacy flip meaning, caps ffmpeg output and isolates cleanup failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rev-part4-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const calls = [], sends = [], edits = [], errors = [];
  const signal = new AbortController().signal;
  const source = {media: {}, photo: {}};
  const client = {async *iterDownload() {yield Buffer.from('a'); yield Buffer.from('b');}, async sendFile(_peer, value) {sends.push(value);}};
  const context = {signal, log: {error(event) {errors.push(event);}}, files: {async withTemp(operation) {const directory = await fs.mkdtemp(path.join(root, 'job-')); try {return await operation(directory, signal);} finally {await fs.rm(directory, {recursive: true, force: true});}}},
    processes: {async run(command, args) {calls.push({command, args}); await fs.writeFile(args.at(-1), 'result'); return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0};}},
    telegram: {async edit(_message, text) {edits.push(text);}, async getReply() {return {id: 2, text: '', raw: source};},
      async withClient(operation) {return operation(client, signal);}}};
  await create().commands.rev.handle({command: 'rev', prefix: '.', args: ['h'], message: {id: 3, chatId: '1', replyToId: 2, text: '.rev h', outgoing: true,
    raw: {peerId: 'peer', async delete() {throw new Error('delete failed');}}}}, context);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('hflip'));
  assert.deepEqual(calls[0].args.slice(-3), ['-fs', String(50 * 1024 * 1024), calls[0].args.at(-1)]);
  assert.equal(sends.length, 1);
  assert.ok(errors.includes('rev_command_cleanup_failed'));
  assert.doesNotMatch(edits.at(-1) || '', /媒体处理失败/);
  assert.deepEqual(create().commands.rev.helpArgs, ['help']);
});
