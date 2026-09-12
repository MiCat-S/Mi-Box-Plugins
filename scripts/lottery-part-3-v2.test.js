'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const Utils = require(path.join(core, 'node_modules/teleproto/Utils'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'lottery', packageRoot: path.resolve(__dirname, '../lottery'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function memory(initial) {
  let value = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    read: () => tail.then(() => structuredClone(value)),
    update(operation) {
      const next = tail.then(async () => {
        value = await operation(structuredClone(value));
        return structuredClone(value);
      });
      tail = next.then(() => undefined, () => undefined);
      return next;
    },
    value: () => structuredClone(value),
  };
}

function activity(chatId) {
  return {id: 'activity', chatId, title: 'event', keyword: 'JOIN', maxParticipants: 2, winnerCount: 1,
    warehouse: 'default', creatorId: '1', createdAt: 1, status: 'active', deleteDelay: 0, claimTimeout: 60,
    requireAvatar: false, requireUsername: false, allowBots: false, participants: [], winners: []};
}

function fixture(client, chatId = '-1009007199254740993', senderId = '9007199254740995') {
  const json = memory({schemaVersion: 1, activities: {activity: activity(chatId)}, warehouses: {default: []},
    settings: {minUsers: 2, maxUsers: 1000}, importedLegacy: true});
  const edits = [], sent = [];
  client.sendMessage = async (peer, options) => {sent.push({peer, options}); return {id: sent.length};};
  client.deleteMessages = async () => {};
  const signal = new AbortController().signal;
  const context = {signal, storage: {json: () => json}, tasks: {run: async (_label, operation) => operation(signal)},
    telegram: {edit: async (_message, text) => edits.push(text), reply: async () => {},
      withClient: operation => operation(client, signal)}, log: {error() {}}};
  return {json, edits, sent, run: () => create().commands.lottery.subcommands.draw.handle({
    command: 'lottery', subcommand: 'draw', prefix: '.', args: [],
    message: {id: 1, chatId, senderId, outgoing: true, text: '.lottery draw'},
  }, context)};
}

test('lottery channel admin check resolves and serializes the exact 64-bit participant ID', async () => {
  const channelId = 9007199254740993n;
  const userId = 9007199254740995n;
  const channel = new Api.Channel({id: channelId, accessHash: 77n, title: 'group', photo: new Api.ChatPhotoEmpty(),
    date: 1, megagroup: true});
  const serialized = [];
  const client = {
    async getEntity(value) {assert.equal(value, '-1009007199254740993'); return channel;},
    async getInputEntity(value) {
      if (value === channel) return new Api.InputPeerChannel({channelId, accessHash: 77n});
      assert.equal(value, userId.toString());
      return new Api.InputPeerUser({userId, accessHash: 88n});
    },
    async invoke(request) {
      await request.resolve(client, Utils);
      serialized.push(request.getBytes());
      assert.ok(request instanceof Api.channels.GetParticipant);
      assert.equal(request.channel.channelId.toString(), channelId.toString());
      assert.equal(request.participant.userId.toString(), userId.toString());
      return {participant: new Api.ChannelParticipantAdmin({userId, adminRights: new Api.ChatAdminRights({other: true})})};
    },
  };
  const f = fixture(client);
  await f.run();
  assert.equal(serialized.length, 1);
  assert.ok(serialized[0].byteLength > 12);
  assert.equal(f.json.value().activities.activity.status, 'completed');
});

test('lottery basic-group admin check uses messages.GetFullChat and serializes its exact chat ID', async () => {
  const chatId = 9007199254740993n;
  const userId = '9007199254740995';
  const chat = new Api.Chat({id: chatId, title: 'basic', photo: new Api.ChatPhotoEmpty(), participantsCount: 2,
    date: 1, version: 1});
  const serialized = [];
  const client = {
    async getEntity(value) {assert.equal(value, `-${chatId}`); return chat;},
    async invoke(request) {
      await request.resolve(client, Utils);
      serialized.push(request.getBytes());
      assert.ok(request instanceof Api.messages.GetFullChat);
      assert.equal(request.chatId.toString(), chatId.toString());
      return {fullChat: {participants: {participants: [
        {className: 'ChatParticipantAdmin', userId},
      ]}}};
    },
  };
  const f = fixture(client, `-${chatId}`, userId);
  await f.run();
  assert.equal(serialized.length, 1);
  assert.ok(serialized[0].byteLength > 8);
  assert.equal(f.json.value().activities.activity.status, 'completed');
});

test('lottery concurrent create reserves atomically and sends only one announcement', async () => {
  const json = memory({schemaVersion: 1, activities: {}, warehouses: {default: [{text: 'prize', stock: 2, order: 0}]},
    settings: {minUsers: 2, maxUsers: 1000}, importedLegacy: true});
  const edits = [], sends = [];
  const signal = new AbortController().signal;
  const client = {async sendMessage(peer, options) {sends.push({peer, options}); return {id: 9};}, async pinMessage() {}};
  const context = {signal, storage: {json: () => json}, telegram: {edit: async (_message, text) => edits.push(text),
    reply: async () => {}, withClient: operation => operation(client, signal)}, log: {error() {}}};
  const command = create().commands.lottery.subcommands.create;
  const invoke = id => command.handle({command: 'lottery', subcommand: 'create', prefix: '.',
    args: ['event', 'JOIN', '2', '1', 'default'], message: {id, chatId: '-1001', senderId: '7', outgoing: true, text: '.lottery create'}}, context);
  await Promise.all([invoke(1), invoke(2)]);
  assert.equal(sends.length, 1);
  assert.equal(Object.values(json.value().activities).filter(item => item.status === 'active').length, 1);
  assert.ok(edits.some(text => /已有进行中的抽奖/.test(text)));
});
