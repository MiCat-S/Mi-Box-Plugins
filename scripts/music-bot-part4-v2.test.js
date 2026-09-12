'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const create = require(path.join(buildPlugin({id: 'music_bot', packageRoot: path.resolve(__dirname, '../music_bot'), entry: 'v2.ts'}).artifactDir, 'index.cjs')).default;

test('music_bot uses the high-level notify helper and keeps a successful send after cleanup failure', async () => {
  const history = [], sends = [], notifications = [], edits = [], errors = [];
  const signal = new AbortController().signal;
  const client = {async invoke() {}, async getInputEntity(value) {return value;}, async updateNotifySettings(peer, options) {notifications.push({peer, options});},
    async getMessages() {return history.slice();}, async sendMessage(_bot, value) {const sent = {id: 10, out: true}; history.unshift(sent); const choice = {id: 11, out: false, buttonCount: 1,
      async click() {history.unshift({id: 12, out: false, media: {song: value.message}});}}; history.unshift(choice); return sent;},
    async sendFile(_peer, value) {sends.push(value);}};
  const context = {signal, log: {error(event) {errors.push(event);}}, telegram: {async edit(_message, text) {edits.push(text);},
    async withClient(operation) {return operation(client, signal);}}};
  const plugin = create();
  await plugin.commands.mbvk.handle({command: 'mbvk', prefix: '.', args: ['song'], message: {id: 1, chatId: '1', text: '.mbvk song', outgoing: true,
    raw: {peerId: 'peer', async delete() {throw new Error('delete failed');}}}}, context);
  assert.equal(notifications.length, 1);
  assert.equal(sends[0].file.song, 'song');
  assert.ok(errors.includes('music_bot_command_cleanup_failed'));
  assert.doesNotMatch(edits.at(-1) || '', /音乐搜索失败/);
  plugin.cleanup();
});
