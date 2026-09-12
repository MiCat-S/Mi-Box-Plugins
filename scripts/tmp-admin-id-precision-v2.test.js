'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const Utils = require(path.join(core, 'node_modules/teleproto/Utils.js'));
const {artifactDir} = buildPlugin({id: 'tmp_admin', packageRoot: path.resolve(__dirname, '../tmp_admin'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('tmp_admin resolves an unsafe-range decimal user id without Number coercion and serializes EditAdmin', async () => {
  const chatId = '9007199254740993';
  const userId = '9007199254740995';
  let data = {schemaVersion: 1, jobs: {}, enabled: true};
  let participant = {className: 'ChannelParticipant', rank: ''};
  const requests = [], resources = [];
  const controller = new AbortController();
  const client = {
    async getEntity(value) {
      if (String(value) === `-100${chatId}`) return {className: 'Channel', id: BigInt(chatId)};
      if (String(value) === userId) throw new Error('not in entity cache');
      return value;
    },
    async getInputEntity(value) {
      if (value?.className === 'Channel') return new Api.InputChannel({channelId: BigInt(chatId), accessHash: 70n});
      if (value?.className === 'User') return new Api.InputUser({userId: BigInt(userId), accessHash: 420n});
      return value;
    },
    async invoke(request) {
      requests.push(request);
      if (request instanceof Api.channels.GetParticipants) return {
        participants: [{userId: BigInt(userId)}], users: [{className: 'User', id: BigInt(userId), firstName: 'Precise'}],
      };
      if (request instanceof Api.channels.GetParticipant) return {participant};
      if (request instanceof Api.channels.EditAdmin) { participant = {className: 'ChannelParticipantAdmin', rank: request.rank, adminRights: request.adminRights}; return {}; }
      return {};
    },
  };
  const context = {signal: controller.signal, log: {error() {}}, telegram: {
    async edit() {}, async getReply() {}, async withClient(operation) { return operation(client, controller.signal); },
  }, storage: {json() { return {
    async read() { return structuredClone(data); },
    async update(operation) { data = await operation(structuredClone(data)); return structuredClone(data); },
  }; }}, tasks: {
    add(label, cleanup) { const resource = {label, cleanup}; resources.push(resource); return async () => {
      const index = resources.indexOf(resource); if (index >= 0) resources.splice(index, 1); await cleanup();
    }; },
    run(_label, operation) { return Promise.resolve(operation(controller.signal)); },
  }};
  const plugin = create();
  await plugin.setup(context);
  const running = plugin.commands.tmp_admin.subcommands.add.handle({command: 'tmp_admin', prefix: '.', args: [userId, '30'],
    subcommand: 'add', subcommands: ['add'], message: {id: 1, chatId: `-100${chatId}`, outgoing: true,
      text: `.tmp_admin add ${userId} 30`, raw: {peerId: `-100${chatId}`}}}, context);
  while (!data.jobs[`${chatId}:${userId}`]) await new Promise(resolve => setImmediate(resolve));
  const request = requests.find(value => value instanceof Api.channels.EditAdmin);
  assert.ok(request);
  await request.resolve(client, Utils);
  assert.equal(String(request.channel.channelId), chatId);
  assert.equal(String(request.userId.userId), userId);
  assert.ok(request.getBytes().length > 0);
  assert.equal(data.jobs[`${chatId}:${userId}`].userId, userId);
  controller.abort(new DOMException('test complete', 'AbortError'));
  await running;
  await plugin.cleanup(context);
  assert.equal(resources.length, 0);
});
