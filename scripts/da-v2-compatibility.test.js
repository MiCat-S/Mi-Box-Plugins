'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {Api, utils} = require(path.join(core, 'node_modules/teleproto'));
const {returnBigInt} = require(path.join(core, 'node_modules/teleproto/Helpers.js'));

function create(options) {
  const {artifactDir} = buildPlugin({id: 'da', packageRoot: path.resolve(__dirname, '../da'), entry: 'v2.ts'});
  const entry = path.join(artifactDir, 'index.cjs'); delete require.cache[require.resolve(entry)]; return require(entry).default(options);
}
const plugin = () => create();
const waitFor = async predicate => {for (let index = 0; index < 200; index++) {if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10));} assert.fail('condition not reached');};

test('da admin flow serializes permission RPC, reports completion, and removes completed state', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-da-compat-')));
  const me = new Api.User({id: returnBigInt('9007199254740991'), accessHash: returnBigInt(2), firstName: 'Owner'});
  const chat = new Api.Channel({id: returnBigInt('9007199254740993'), accessHash: returnBigInt(3), title: 'Group', megagroup: true,
    photo: new Api.ChatPhotoEmpty(), date: 0});
  const peer = new Api.PeerChannel({channelId: chat.id});
  const deletions = [], saved = [], edited = [], requests = [];
  const input = value => value instanceof Api.InputPeerSelf ? value : value instanceof Api.Channel
    ? new Api.InputChannel({channelId: value.id, accessHash: value.accessHash}) : value;
  const client = {
    async getEntity() {return chat;}, async getMe() {return me;}, async getInputEntity(value) {return input(value);},
    async invoke(request) {
      requests.push(request);
      await request.resolve({getInputEntity: async value => input(value)}, utils); request.getBytes();
      if (request instanceof Api.channels.GetParticipant) return {participant: new Api.ChannelParticipantCreator({userId: me.id})};
      throw new Error('unexpected RPC');
    },
    async *iterMessages() {
      yield new Api.Message({id: 21, peerId: peer, fromId: new Api.PeerUser({userId: me.id}), message: 'one'});
      yield new Api.Message({id: 22, peerId: peer, fromId: new Api.PeerUser({userId: me.id}), message: 'two'});
    },
    async deleteMessages(target, ids, options) {deletions.push({target, ids, options});},
    async sendMessage(target, options) {saved.push({target, options}); return {id: 500};},
    async editMessage(target, options) {edited.push({target, options});},
  };
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit() {}, async reply() {}, async invoke() {}, async getReply() {},
    async withClient(operation, signal) {return operation(client, signal);},
  }});
  await host.load(plugin());
  t.after(async () => {await host.shutdown(2000); await fs.rm(root, {recursive: true, force: true});});

  await host.dispatchPrimary({id: 10, chatId: '-1009007199254740993', senderId: me.id.toString(), outgoing: true,
    text: '.da true', raw: {peerId: peer, isPrivate: false}});
  await waitFor(async () => {
    try {return JSON.parse(await fs.readFile(path.join(root, 'da', 'database.json'), 'utf8')).tasks.length === 0 && edited.length > 0;}
    catch {return false;}
  });
  assert.ok(requests[0] instanceof Api.channels.GetParticipant);
  assert.ok(requests[0].participant instanceof Api.InputPeerSelf);
  assert.deepEqual(deletions.map(value => value.ids), [[10], [21, 22]]);
  assert.equal(saved.length, 1);
  assert.match(edited.at(-1).options.text, /任务完成/);
  assert.match(edited.at(-1).options.text, /已删除：2 条/);
});

test('da treats whitespace-only arguments as help without native side effects', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-da-help-')));
  let native = 0; const edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(_message, text) {edits.push(text);}, async reply() {}, async invoke() {}, async getReply() {},
    async withClient() {native += 1;},
  }});
  await host.load(plugin());
  t.after(async () => {await host.shutdown(2000); await fs.rm(root, {recursive: true, force: true});});
  await host.dispatchPrimary({id: 10, chatId: '-1009', senderId: '7', outgoing: true, replyToId: 8,
    text: '.da   \n  ', raw: {media: {photo: {}}, peerId: new Api.PeerChannel({channelId: returnBigInt(9)})}});
  assert.equal(native, 0);
  assert.match(edits.at(-1), /批量删除/);
});

test('da stop cancels an in-flight iterator before deletion and persists a paused task', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-da-stop-')));
  const me = new Api.User({id: returnBigInt(7), accessHash: returnBigInt(2), firstName: 'Owner'});
  const chat = new Api.Channel({id: returnBigInt(9), accessHash: returnBigInt(3), title: 'Group', megagroup: true,
    photo: new Api.ChatPhotoEmpty(), date: 0});
  let iteratorStarted;
  let releaseIterator;
  const started = new Promise(resolve => {iteratorStarted = resolve;});
  const release = new Promise(resolve => {releaseIterator = resolve;});
  const deleted = [];
  const client = {async getEntity() {return chat;}, async getMe() {return me;},
    async invoke(request) {if (request instanceof Api.channels.GetParticipant) return {participant: new Api.ChannelParticipantCreator({userId: me.id})}; throw new Error('unexpected');},
    async *iterMessages() {iteratorStarted(); await release; yield new Api.Message({id: 21, message: 'late'});},
    async deleteMessages(_peer, ids) {deleted.push(ids);}, async sendMessage() {return {id: 500};}, async editMessage() {}};
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient(operation, signal) {return operation(client, signal);},
  }});
  await host.load(plugin());
  t.after(async () => {await host.shutdown(2000); await fs.rm(root, {recursive: true, force: true});});
  await host.dispatchPrimary({id: 10, chatId: '-1009', senderId: '7', outgoing: true, text: '.da true', raw: {peerId: chat, isPrivate: false}});
  await started;
  await host.dispatchPrimary({id: 11, chatId: '-1009', senderId: '7', outgoing: true, text: '.da stop', raw: {peerId: chat, isPrivate: false}});
  releaseIterator();
  await waitFor(async () => {
    const state = JSON.parse(await fs.readFile(path.join(root, 'da', 'database.json'), 'utf8'));
    return state.tasks[0]?.isPaused === true;
  });
  assert.deepEqual(deleted, [[10], [11]]);
  const state = JSON.parse(await fs.readFile(path.join(root, 'da', 'database.json'), 'utf8'));
  assert.equal(state.tasks[0].isRunning, false);
  assert.equal(state.tasks[0].deletedMessages, 0);
});

async function floodFixture(t, error, pause) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-da-flood-')));
  const me = {id: returnBigInt(7)};
  const chat = {className: 'Channel', id: returnBigInt(9), title: 'Group'};
  let batchCalls = 0;
  const client = {async getEntity() {return chat;}, async getMe() {return me;},
    async invoke(request) {if (request instanceof Api.channels.GetParticipant) return {participant: {className: 'ChannelParticipantCreator'}}; throw new Error('unexpected');},
    async *iterMessages() {yield {className: 'Message', id: 21};},
    async deleteMessages(_peer, ids) {if (ids.includes(21)) {batchCalls += 1; if (batchCalls === 1) throw error;}},
    async sendMessage() {return {id: 500};}, async editMessage() {}};
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient(operation, signal) {return operation(client, signal);},
  }});
  await host.load(create({sleep: pause}));
  t.after(async () => {await host.shutdown(2000); await fs.rm(root, {recursive: true, force: true});});
  const run = id => host.dispatchPrimary({id, chatId: '-1009', senderId: '7', outgoing: true,
    text: id === 10 ? '.da true' : '.da stop', raw: {peerId: chat, isPrivate: false}});
  return {host, root, run, batchCalls: () => batchCalls};
}

test('da preserves a normal short FLOOD_WAIT before one retry', async t => {
  const waits = [];
  const fixture = await floodFixture(t, Object.assign(new Error('private'), {errorMessage: 'FLOOD_WAIT_1'}),
    async (ms, signal) => {signal.throwIfAborted(); waits.push(ms);});
  await fixture.run(10);
  await waitFor(() => fixture.batchCalls() === 2);
  assert.deepEqual(waits, [1000]);
});

test('da segments a FLOOD_WAIT beyond the native timer range and stop prevents retry', async t => {
  const waits = [];
  let segmentStarted;
  const started = new Promise(resolve => {segmentStarted = resolve;});
  const fixture = await floodFixture(t, Object.assign(new Error('private'), {errorMessage: 'FLOOD_WAIT_2147484'}),
    (ms, signal) => new Promise((resolve, reject) => {waits.push(ms); segmentStarted();
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});}));
  await fixture.run(10);
  await started;
  await fixture.run(11);
  await waitFor(async () => JSON.parse(await fs.readFile(path.join(fixture.root, 'da', 'database.json'), 'utf8')).tasks[0]?.isPaused === true);
  assert.deepEqual(waits, [60000]);
  assert.ok(waits.every(value => value <= 60000));
  assert.equal(fixture.batchCalls(), 1);
});

test('da does not retry an unsafe FLOOD_WAIT value', async t => {
  const waits = [];
  const fixture = await floodFixture(t, Object.assign(new Error('private'), {errorMessage: 'FLOOD_WAIT_999999999999999999999'}),
    async ms => {waits.push(ms);});
  await fixture.run(10);
  await waitFor(async () => JSON.parse(await fs.readFile(path.join(fixture.root, 'da', 'database.json'), 'utf8')).tasks[0]?.isRunning === false);
  assert.deepEqual(waits, []);
  assert.equal(fixture.batchCalls(), 1);
});
