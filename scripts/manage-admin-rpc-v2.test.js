'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'manage_admin', packageRoot: path.resolve(__dirname, '../manage_admin'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const Utils = require(path.join(core, 'node_modules/teleproto/Utils.js'));

test('manage_admin resolves and serializes current-account participant lookup with exact channel ID', async () => {
  const channelId = 90071992547409931234n;
  const channel = new Api.Channel({id: channelId, accessHash: 812337203685477001n, title: 'Group', megagroup: true,
    photo: new Api.ChatPhotoEmpty(), date: 0});
  const input = new Api.InputPeerChannel({channelId, accessHash: channel.accessHash});
  const requests = [], edits = [];
  const client = {
    async getEntity() {return channel;},
    async getInputEntity(value) {return value instanceof Api.InputPeerSelf ? value : input;},
    async invoke(request) {
      requests.push(request);
      return {participant: new Api.ChannelParticipantAdmin({userId: 1n, adminRights: new Api.ChatAdminRights({addAdmins: false})})};
    },
  };
  const signal = new AbortController().signal;
  const context = {signal, telegram: {async edit(_message, text) {edits.push(text);}, async getReply() {}, async withClient(operation) {return operation(client, signal);}}};
  await create().commands.manage_admin.handle({command: 'manage_admin', prefix: '.', args: ['add', '2'],
    message: {id: 1, chatId: `-100${channelId}`, text: '.manage_admin add 2', outgoing: true, raw: {peerId: input, isChannel: true}}}, context);
  const request = requests.find(value => value instanceof Api.channels.GetParticipant);
  assert.ok(request);
  assert.ok(request.participant instanceof Api.InputPeerSelf);
  await request.resolve(client, Utils);
  assert.equal(request.channel.channelId.toString(), channelId.toString());
  assert.ok(request.participant instanceof Api.InputPeerSelf);
  assert.ok(request.getBytes().length > 0);
  assert.match(edits.at(-1), /权限不足/);
});

test('manage_admin preserves whole Unicode title characters and serializes EditAdmin', async () => {
  const channelId = 90071992547409931234n, userId = 80071992547409931234n;
  const channel = new Api.Channel({id: channelId, accessHash: 11n, title: 'Group', megagroup: true, photo: new Api.ChatPhotoEmpty(), date: 0});
  const user = new Api.User({id: userId, accessHash: 22n, firstName: 'Target'});
  const inputChannel = new Api.InputPeerChannel({channelId, accessHash: 11n}), inputUser = new Api.InputPeerUser({userId, accessHash: 22n});
  const requests = [];
  const client = {async getEntity(value) {return value === inputChannel || String(value).startsWith('-100') ? channel : user;},
    async getInputEntity(value) {if (value instanceof Api.InputPeerSelf) return value; return value === channel || value === inputChannel ? inputChannel : inputUser;},
    async invoke(request) {requests.push(request); if (request instanceof Api.channels.GetParticipant) return {participant: request.participant instanceof Api.InputPeerSelf ?
      new Api.ChannelParticipantCreator({userId: 1n}) : new Api.ChannelParticipantAdmin({userId, adminRights: new Api.ChatAdminRights({banUsers: true}), rank: request.rank})}; return {};}};
  const signal = new AbortController().signal, edits = [];
  const context = {signal, telegram: {async edit(_message, text) {edits.push(text);}, async getReply() {}, async withClient(operation) {return operation(client, signal);}}};
  const title = '123456789012345😀extra';
  await create().commands.manage_admin.handle({command: 'manage_admin', prefix: '.', args: ['add', userId.toString(), title],
    message: {id: 1, chatId: `-100${channelId}`, text: `.manage_admin add ${userId} ${title}`, outgoing: true, raw: {peerId: inputChannel, isChannel: true}}}, context);
  const request = requests.find(value => value instanceof Api.channels.EditAdmin);
  assert.ok(request);
  assert.equal(Array.from(request.rank).length, 16);
  assert.equal(request.rank.endsWith('😀'), true);
  await request.resolve(client, Utils);
  assert.equal(request.channel.channelId.toString(), channelId.toString());
  assert.equal(request.userId.userId.toString(), userId.toString());
  assert.ok(request.getBytes().length > 0);
  assert.ok(edits.length > 0);
});
