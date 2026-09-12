'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const create = require(path.join(buildPlugin({id: 'save', packageRoot: path.resolve(__dirname, '../save'), entry: 'v2.ts'}).artifactDir, 'index.cjs')).default;

test('save paginates source notices and reports later notice failure without undoing forwards', async () => {
  let data = {schemaVersion: 1, users: {'99': {target: 'me', showSource: true}}};
  const edits = [], notices = [], errors = [];
  const signal = new AbortController().signal;
  const client = {async getInputEntity(value) {return value;}, async getMessages(_peer, options) {return [{id: options.ids[0], peerId: 'source', text: 'message'}];},
    async forwardMessages() {return [{id: 5000}];}, async sendMessage(_target, options) {notices.push(options); if (notices.length === 2) throw new Error('notice failed'); return {id: 5000 + notices.length};}};
  const context = {signal, log: {error(event) {errors.push(event);}}, storage: {json() {return {async read() {return structuredClone(data);},
    async update(change) {data = await change(structuredClone(data)); return data;}}}}, files: {dataPath() {throw new Error('legacy read not expected');}},
    telegram: {async edit(_message, text) {edits.push(text);}, async getReply() {}, async withClient(operation) {return operation(client, signal);}}};
  await create().commands.save.handle({command: 'save', prefix: '.', args: ['https://t.me/c/7/1|https://t.me/c/7/500'],
    message: {id: 1, chatId: '1', senderId: '99', text: '.save range', outgoing: true}}, context);
  assert.equal(notices.length, 2);
  assert.ok(notices.every(value => value.message.length <= 3500));
  assert.match(edits.at(-1), /成功: 500\/500/);
  assert.match(edits.at(-1), /来源通知发送失败/);
  assert.ok(errors.includes('save_source_notice_failed'));
});
