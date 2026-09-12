'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'clean', packageRoot: path.resolve(__dirname, '../clean'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));

test('clean snapshots every deleted member before mutating membership', async () => {
  const users = [{className: 'User', id: 2n, deleted: true}, {className: 'User', id: 3n, deleted: true}];
  let scanComplete = false; const removed = [], edits = [];
  const chat = {className: 'Chat', id: 9007199254740993n, creator: true};
  const client = {
    async getEntity() {return chat;}, async getInputEntity(value) {return value;}, async getMe() {return {id: 1n};},
    async *iterParticipants() {for (const user of users) yield user; scanComplete = true;},
    async invoke(request) {assert.equal(scanComplete, true, 'membership mutation must begin after the scan'); assert.ok(request instanceof Api.messages.DeleteChatUser); removed.push(request.userId.id); return {};},
  };
  const signal = new AbortController().signal;
  const context = {signal, log: {info() {}, error() {}}, telegram: {async edit(message, text) {edits.push(text);}, async withClient(operation) {return operation(client, signal);}}};
  await create().commands.clean.subcommands.deleted.subcommands.member.subcommands.rm.handle({command: 'clean', subcommand: 'rm', subcommands: ['deleted', 'member', 'rm'], prefix: '.', args: [],
    message: {id: 1, chatId: '-9', outgoing: true, text: '.clean deleted member rm', raw: {peerId: chat, isGroup: true}}}, context);
  assert.deepEqual(removed, [2n, 3n]);
  assert.match(edits.at(-1), /成功移出 <code>2<\/code>/);
});
