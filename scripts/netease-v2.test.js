'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'netease', packageRoot: path.resolve(__dirname, '../netease'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const Utils = require(path.join(core, 'node_modules/teleproto/Utils.js'));

function fixture(deleteFails = false) {
  const plugin = create();
  const edits = [], sends = [], invokes = [], errors = [];
  const history = [{id: 100, out: false, media: {stale: true}, message: 'stale'}];
  let nextId = 101;
  const signal = new AbortController().signal;
  const client = {
    async invoke(request) {invokes.push(request); return {};},
    async getInputEntity() {return new Api.InputPeerUser({userId: 123n, accessHash: 456n});},
    async getMessages() {return history.slice().sort((a, b) => b.id - a.id);},
    async sendMessage(_bot, options) {
      const sent = {id: nextId++, out: true, message: options.message}; history.unshift(sent);
      const media = {request: options.message}; history.unshift({id: nextId++, out: false, media, message: `song ${options.message}`});
      return sent;
    },
    async sendFile(peer, options) {sends.push({peer, options});},
  };
  const context = {signal, log: {error(event) {errors.push(event);}}, telegram: {
    async edit(_message, text) {edits.push(text);}, async withClient(operation) {return operation(client, signal);},
  }};
  const run = keyword => plugin.commands.netease.handle({command: 'netease', prefix: '.', args: [keyword],
    message: {id: 1, chatId: '-1001', text: `.netease ${keyword}`, outgoing: true, raw: {peerId: `chat-${keyword}`, async delete() {if (deleteFails) throw new Error('delete failed');}}}}, context);
  return {client, context, run, sends, invokes, edits, errors};
}

test('netease ignores stale media and serializes concurrent bot conversations', async () => {
  const f = fixture();
  await Promise.all([f.run('first'), f.run('second')]);
  assert.deepEqual(f.sends.map(item => item.options.file.request), ['/search first', '/search second']);
  assert.deepEqual(f.sends.map(item => item.peer), ['chat-first', 'chat-second']);
  assert.ok(f.sends.every(item => !item.options.file.stale));
});

test('netease keeps a successful media result when command cleanup fails', async () => {
  const f = fixture(true);
  await f.run('cleanup');
  assert.equal(f.sends.length, 1);
  assert.ok(f.errors.includes('netease_command_cleanup_failed'));
  assert.doesNotMatch(f.edits.at(-1), /获取失败/);
});

test('netease native StartBot request resolves and serializes through teleproto', async () => {
  const f = fixture();
  await f.run('123456');
  const request = f.invokes.find(value => value instanceof Api.messages.StartBot);
  assert.ok(request);
  await request.resolve(f.client, Utils);
  assert.ok(request.bot instanceof Api.InputUser);
  assert.ok(request.peer instanceof Api.InputPeerUser);
  assert.ok(request.getBytes().length > 0);
  assert.equal(f.sends[0].options.file.request, '/music 123456');
});
