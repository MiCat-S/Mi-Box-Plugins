'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const create = require(path.join(buildPlugin({id: 're', packageRoot: path.resolve(__dirname, '../re'), entry: 'v2.ts'}).artifactDir, 'index.cjs')).default;

test('re keeps successful forwarding when command deletion fails', async () => {
  const errors = [], edits = [], requests = [];
  const signal = new AbortController().signal;
  const message = new Api.Message({id: 7, peerId: new Api.PeerChat({chatId: 1n}), message: 'source'});
  const context = {signal, log: {error(event) {errors.push(event);}}, telegram: {async edit(_message, text) {edits.push(text);},
    async getReply() {return {id: 7, chatId: 'source', text: 'source', raw: {async getInputChat() {return 'source';}}};},
    async withClient(operation) {return operation({async getMessages() {return [message];}, async invoke(request) {requests.push(request);}}, signal);}}};
  await create().commands.re.handle({command: 're', prefix: '.', args: [], message: {id: 8, chatId: 'target', replyToId: 7, text: '.re', outgoing: true,
    raw: {async getInputChat() {return 'target';}, async delete() {throw new Error('delete failed');}}}}, context);
  assert.equal(requests.length, 1);
  assert.ok(errors.includes('re_command_cleanup_failed'));
  assert.deepEqual(edits, []);
});
