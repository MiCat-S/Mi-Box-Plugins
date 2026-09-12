'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const create = require(path.join(buildPlugin({id: 'premium', packageRoot: path.resolve(__dirname, '../premium'), entry: 'v2.ts'}).artifactDir, 'index.cjs')).default;

test('premium warns when iteration itself reaches the Telegram 10000-member ceiling', async () => {
  const edits = [];
  const signal = new AbortController().signal;
  const chat = new Api.Channel({id: 1n, accessHash: 2n, title: 'Group', megagroup: true, photo: new Api.ChatPhotoEmpty(), date: 0, participantsCount: 0});
  const client = {async getEntity() {return chat;}, async invoke() {return {fullChat: {participantsCount: 0}};}, async *iterParticipants() {
    for (let index = 0; index < 10_000; index++) yield {id: BigInt(index + 1), premium: index === 0};
  }};
  const context = {signal, log: {error() {}}, telegram: {async edit(_message, text) {edits.push(text);},
    async withClient(operation) {return operation(client, signal);}}};
  await create().commands.premium.handle({command: 'premium', prefix: '.', args: ['force'], message: {id: 1, chatId: '-1001', text: '.premium force', outgoing: true, raw: {peerId: 'peer'}}}, context);
  assert.match(edits.at(-1), /10,000/);
  assert.match(edits.at(-1), /结果可能不完整/);
});
