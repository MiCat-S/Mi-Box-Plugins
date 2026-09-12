'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'restore_pin', packageRoot: path.resolve(__dirname, '../restore_pin'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const Utils = require(path.join(core, 'node_modules/teleproto/Utils.js'));

test('restore_pin resolves current-account permission lookup and admin-log request', async () => {
  const channelId = 90071992547409931234n;
  const channel = new Api.Channel({id: channelId, accessHash: 33n, title: 'Group', megagroup: true, photo: new Api.ChatPhotoEmpty(), date: 0});
  const input = new Api.InputPeerChannel({channelId, accessHash: 33n});
  const requests = [];
  const client = {async getEntity() {return channel;}, async getInputEntity(value) {return value instanceof Api.InputPeerSelf ? value : input;}, async invoke(request) {
    requests.push(request);
    if (request instanceof Api.channels.GetParticipant) return {participant: new Api.ChannelParticipantCreator({userId: 1n})};
    if (request instanceof Api.channels.GetAdminLog) return {events: []};
    return {};
  }};
  const signal = new AbortController().signal;
  const context = {signal, log: {error() {}}, telegram: {async edit() {}, async withClient(operation) {return operation(client, signal);}}};
  await create().commands.restore_pin.handle({command: 'restore_pin', prefix: '.', args: [], message: {id: 1, chatId: `-100${channelId}`,
    text: '.restore_pin', outgoing: true, raw: {peerId: input}}}, context);
  for (const request of requests) {
    await request.resolve(client, Utils);
    assert.equal(request.channel.channelId.toString(), channelId.toString());
    assert.ok(request.getBytes().length > 0);
  }
  assert.ok(requests.some(value => value instanceof Api.channels.GetParticipant));
  assert.ok(requests.some(value => value instanceof Api.channels.GetAdminLog));
});

test('restore_pin resolves and serializes the actual pin update after permission checks', async () => {
  const channelId = 90071992547409931234n;
  const channel = new Api.Channel({id: channelId, accessHash: 33n, title: 'Group', megagroup: true, photo: new Api.ChatPhotoEmpty(), date: 0});
  const input = new Api.InputPeerChannel({channelId, accessHash: 33n});
  const requests = [];
  const unpinned = new Api.Message({id: 77, peerId: new Api.PeerChannel({channelId}), message: 'restore', pinned: false});
  const event = new Api.ChannelAdminLogEvent({id: 1n, date: 0, userId: 1n,
    action: new Api.ChannelAdminLogEventActionUpdatePinned({message: unpinned})});
  const client = {async getEntity() {return channel;}, async getInputEntity() {return input;}, async invoke(request) {
    requests.push(request);
    if (request instanceof Api.channels.GetParticipant) return {participant: new Api.ChannelParticipantAdmin({userId: 1n, adminRights: new Api.ChatAdminRights({pinMessages: true})})};
    if (request instanceof Api.channels.GetAdminLog) return {events: [event]};
    return {};
  }};
  const signal = new AbortController().signal;
  const context = {signal, log: {error() {}}, telegram: {async edit() {}, async withClient(operation) {return operation(client, signal);}}};
  await create().commands.restore_pin.handle({command: 'restore_pin', prefix: '.', args: [], message: {id: 1, chatId: `-100${channelId}`,
    text: '.restore_pin', outgoing: true, raw: {peerId: input}}}, context);
  const request = requests.find(value => value instanceof Api.messages.UpdatePinnedMessage);
  assert.ok(request);
  await request.resolve(client, Utils);
  assert.equal(request.peer.channelId.toString(), channelId.toString());
  assert.equal(request.id, 77);
  assert.ok(request.getBytes().length > 0);
});
