'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'paolu', packageRoot: path.resolve(__dirname, '../paolu'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const Utils = require(path.join(core, 'node_modules/teleproto/Utils.js'));

test('paolu resolves exact current-account lookup before rejecting incomplete rights', async () => {
  const channelId = 90071992547409931234n;
  const channel = new Api.Channel({id: channelId, accessHash: 44n, title: 'Group', megagroup: true, photo: new Api.ChatPhotoEmpty(), date: 0});
  const input = new Api.InputPeerChannel({channelId, accessHash: 44n});
  const requests = [];
  const client = {async getEntity() {return channel;}, async getInputEntity(value) {return value instanceof Api.InputPeerSelf ? value : input;}, async invoke(request) {
    requests.push(request); return {participant: new Api.ChannelParticipantAdmin({userId: 1n, adminRights: new Api.ChatAdminRights({banUsers: true})})};
  }};
  const signal = new AbortController().signal;
  const context = {signal, log: {error() {}}, tasks: {run() {throw new Error('no task expected');}}, telegram: {async edit() {}, async withClient(operation) {return operation(client, signal);}}};
  await create().commands.paolu.handle({command: 'paolu', prefix: '.', args: [], message: {id: 1, chatId: `-100${channelId}`,
    text: '.paolu', outgoing: true, raw: {peerId: input}}}, context);
  const request = requests.find(value => value instanceof Api.channels.GetParticipant);
  assert.ok(request);
  await request.resolve(client, Utils);
  assert.equal(request.channel.channelId.toString(), channelId.toString());
  assert.ok(request.participant instanceof Api.InputPeerSelf);
  assert.ok(request.getBytes().length > 0);
});

test('paolu fails closed on help or unknown arguments without native access', async () => {
  let native = 0; const edits = [];
  const context = {signal: new AbortController().signal, telegram: {async edit(_message, text) {edits.push(text);}, async withClient() {native++;}}};
  for (const args of [['help'], ['typo']]) await create().commands.paolu.handle({command: 'paolu', prefix: '.', args,
    message: {id: 1, chatId: '-1001', text: `.paolu ${args[0]}`, outgoing: true, raw: {peerId: {}}}}, context);
  assert.equal(native, 0);
  assert.ok(edits.every(value => value.includes('.paolu')));
});

test('paolu destructive requests resolve and serialize after exact rights checks', async () => {
  const channelId = 90071992547409931234n;
  const channel = new Api.Channel({id: channelId, accessHash: 44n, title: 'Group', megagroup: true, photo: new Api.ChatPhotoEmpty(), date: 0});
  const input = new Api.InputPeerChannel({channelId, accessHash: 44n});
  const requests = [];
  const client = {async getEntity() {return channel;}, async getInputEntity(value) {return value instanceof Api.InputPeerSelf ? value : input;},
    async invoke(request) {requests.push(request); if (request instanceof Api.channels.GetParticipant) return {participant: new Api.ChannelParticipantCreator({userId: 1n})}; return {};},
    async *iterMessages() {}, async deleteMessages() {}, async sendMessage() {return {id: 9};}};
  const signal = new AbortController().signal;
  const context = {signal, log: {error() {}}, tasks: {run() {return Promise.resolve();}}, telegram: {async edit() {}, async withClient(operation) {return operation(client, signal);}}};
  await create().commands.paolu.handle({command: 'paolu', prefix: '.', args: [], message: {id: 1, chatId: `-100${channelId}`,
    text: '.paolu', outgoing: true, raw: {peerId: input}}}, context);
  const request = requests.find(value => value instanceof Api.messages.EditChatDefaultBannedRights);
  assert.ok(request);
  await request.resolve(client, Utils);
  assert.equal(request.peer.channelId.toString(), channelId.toString());
  assert.ok(request.getBytes().length > 0);
});
