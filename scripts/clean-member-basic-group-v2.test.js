'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'clean_member', packageRoot: path.resolve(__dirname, '../clean_member'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const Utils = require(path.join(core, 'node_modules/teleproto/Utils.js'));

test('clean_member uses basic-group RPCs and preserves large decimal ids', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-member-basic-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const chatId = 9007199254740993n;
  const userId = 922337203685477000n;
  const chat = {className: 'Chat', id: chatId, title: 'Basic group', creator: true};
  const user = {className: 'User', id: userId, firstName: 'Member', lastName: '', username: '', bot: false};
  const inputUser = new Api.InputUser({userId, accessHash: 812337203685477001n});
  const requests = [];
  const client = {
    async getEntity() {return chat;},
    async getMe() {return {id: 1n};},
    async getInputEntity(value) {
      if (value === chat) return new Api.InputPeerChat({chatId});
      if (value === user || value === inputUser) return inputUser;
      return value;
    },
    async invoke(request) {
      requests.push(request);
      if (request instanceof Api.messages.GetFullChat) return {
        fullChat: {participants: {participants: [
          {className: 'ChatParticipantCreator', userId: 1n},
          {className: 'ChatParticipant', userId},
        ]}},
        users: [{className: 'User', id: 1n, firstName: 'Owner'}, user],
      };
      return {};
    },
    async sendFile() {},
  };
  let state = {schemaVersion: 1, entries: {}};
  const signal = new AbortController().signal;
  const context = {
    signal,
    log: {error() {}},
    files: {async dataFile(name) {return path.join(directory, name);}},
    storage: {json: () => ({
      async read() {return structuredClone(state);},
      async update(operation) {state = await operation(structuredClone(state)); return structuredClone(state);},
    })},
    telegram: {async edit() {}, async withClient(operation) {return operation(client, signal);}},
  };
  await create().commands.clean_member.handle({
    command: 'clean_member', prefix: '.', args: ['5'],
    message: {id: 1, chatId: chatId.toString(), outgoing: true, text: '.clean_member 5', raw: {peerId: chat}},
  }, context);

  assert.ok(requests.some(value => value instanceof Api.messages.GetFullChat));
  assert.ok(!requests.some(value => value instanceof Api.channels.GetParticipants));
  assert.ok(!requests.some(value => value instanceof Api.channels.EditBanned));
  const deletion = requests.find(value => value instanceof Api.messages.DeleteChatUser);
  const fullChat = requests.find(value => value instanceof Api.messages.GetFullChat);
  await fullChat.resolve(client, Utils);
  assert.ok(fullChat.getBytes().length > 0);
  assert.equal(fullChat.chatId.toString(), '9007199254740993');
  assert.ok(deletion);
  await deletion.resolve(client, Utils);
  assert.ok(deletion.getBytes().length > 0);
  assert.equal(deletion.chatId.toString(), '9007199254740993');
  assert.equal(deletion.userId.userId.toString(), '922337203685477000');
  const report = Object.values(state.entries)[0];
  assert.equal(report.chat_id, '9007199254740993');
  assert.equal(report.users[0].id, '922337203685477000');
});

test('clean_member resolves and serializes channel participant and removal RPCs', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-member-channel-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const channelId = 9007199254740993n, accessHash = 8007199254740993n, userId = 922337203685477000n;
  const chat = {className: 'Channel', id: channelId, title: 'Channel group'};
  const peer = new Api.InputPeerChannel({channelId, accessHash});
  const user = {className: 'User', id: userId, firstName: 'Member', lastName: '', username: '', bot: false};
  const inputUser = new Api.InputPeerUser({userId, accessHash: 812337203685477001n});
  const requests = [];
  const client = {
    async getEntity() {return chat;}, async getMe() {return {id: 1n};},
    async getInputEntity(value) {if (value === chat || value === peer) return peer; if (value === 1n) return new Api.InputPeerSelf(); if (value === user || value === inputUser) return inputUser; return value;},
    async invoke(request) {
      requests.push(request);
      if (request instanceof Api.channels.GetParticipant) return {participant: {className: 'ChannelParticipantCreator'}};
      if (request instanceof Api.channels.GetParticipants && request.filter instanceof Api.ChannelParticipantsAdmins) return {users: [], participants: []};
      if (request instanceof Api.channels.GetParticipants) return {users: [user], participants: [{className: 'ChannelParticipant', userId}]};
      return {};
    },
    async sendFile() {},
  };
  let state = {schemaVersion: 1, entries: {}};
  const signal = new AbortController().signal;
  const context = {signal, log: {error() {}}, files: {async dataFile(name) {return path.join(directory, name);}},
    storage: {json: () => ({async read() {return structuredClone(state);}, async update(operation) {state = await operation(structuredClone(state)); return structuredClone(state);}})},
    telegram: {async edit() {}, async withClient(operation) {return operation(client, signal);}}};
  await create().commands.clean_member.handle({command: 'clean_member', prefix: '.', args: ['5'],
    message: {id: 1, chatId: channelId.toString(), outgoing: true, text: '.clean_member 5', raw: {peerId: peer}}}, context);
  const native = requests.filter(request => request instanceof Api.channels.GetParticipant || request instanceof Api.channels.GetParticipants || request instanceof Api.channels.EditBanned);
  assert.equal(native.filter(request => request instanceof Api.channels.GetParticipants).length, 2);
  assert.equal(native.filter(request => request instanceof Api.channels.EditBanned).length, 2);
  for (const request of native) {await request.resolve(client, Utils); assert.ok(request.getBytes().length > 0);}
  assert.equal(Object.values(state.entries)[0].users[0].id, userId.toString());
});
