'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'music_bot', packageRoot: path.resolve(__dirname, '../music_bot'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function fixture() {
  const edits = [], sent = [], files = [], clicks = [];
  const choice = {out: false, date: Math.floor(Date.now() / 1000), buttonCount: 1, async click(value) {clicks.push(value);}};
  const media = {out: false, date: choice.date, media: {document: 'audio'}};
  let reads = 0;
  const client = {async invoke() {}, async getInputEntity(value) {return value;}, async sendMessage(peer, value) {sent.push({peer, value});},
    async getMessages() {return ++reads === 1 ? [choice] : [media];}, async sendFile(peer, value) {files.push({peer, value});}};
  const raw = {peerId: 9, async delete() {}};
  const context = {signal: new AbortController().signal, log: {info() {}, error() {}}, telegram: {
    async edit(message, text, options) {edits.push({message, text, options});}, async withClient(operation) {return operation(client, context.signal);},
  }};
  return {edits, sent, files, clicks, run: (command, text) => create().commands[command].handle({command, prefix: '.', args: text.split(/\s+/).slice(1), message: {id: 1, chatId: '9', outgoing: true, text, raw}}, context)};
}

test('music_bot maps source commands, clicks a result, and forwards media', async () => {
  const f = fixture();
  await f.run('mbvk', '.mbvk test song');
  assert.deepEqual(f.sent[0], {peer: '@vkmusic_bot', value: {message: 'test song'}});
  assert.deepEqual(f.clicks, [{i: 0}]);
  assert.equal(f.files[0].peer, 9);
  assert.equal(f.files[0].value.caption, '🎵 test song');
});

test('music_bot validates nested actions locally', async () => {
  const f = fixture();
  await f.run('music_bot', '.music_bot invalid query');
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1).text, /多音源音乐搜索/);
});

test('music_bot keeps YouTube music media caption-free', async () => {
  const f = fixture();
  await f.run('mbym', '.mbym example');
  assert.equal(f.sent[0].peer, '@ttaudiobot');
  assert.equal(f.files[0].value.caption, undefined);
});

test('music_bot serializes requests to the same bot so replies cannot cross-associate', async () => {
  let active = 0, maximum = 0, sequence = 0, reads = 0;
  const files = [];
  const client = {
    async invoke() {}, async getInputEntity(value) {return value;},
    async sendMessage(peer, value) {
      if (value.message === '/start' || value.message === '1') return;
      active += 1; maximum = Math.max(maximum, active); sequence += 1; reads = 0;
    },
    async getMessages() {
      reads += 1;
      return reads === 1
        ? [{id: sequence * 10 + 1, out: false, date: Math.floor(Date.now() / 1000), buttonCount: 1, async click() {}}]
        : [{id: sequence * 10 + 2, out: false, date: Math.floor(Date.now() / 1000), media: {request: sequence}}];
    },
    async sendFile(peer, value) {files.push({peer, value}); active -= 1;},
  };
  const context = {signal: new AbortController().signal, log: {info() {}, error() {}}, telegram: {
    async edit() {}, async withClient(operation) {return operation(client, context.signal);},
  }};
  const command = create().commands.mbvk;
  const invoke = (id, query) => command.handle({command: 'mbvk', prefix: '.', args: [query],
    message: {id, chatId: String(id), outgoing: true, text: `.mbvk ${query}`, raw: {peerId: id, async delete() {}}}}, context);
  await Promise.all([invoke(1, 'first'), invoke(2, 'second')]);
  assert.equal(maximum, 1);
  assert.deepEqual(files.map(value => value.value.file.request), [1, 2]);
});
