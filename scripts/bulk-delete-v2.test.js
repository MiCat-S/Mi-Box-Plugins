'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const {getEventListeners} = require('node:events');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {Api, utils} = require(path.join(core, 'node_modules/teleproto'));
const {returnBigInt: integer} = require(path.join(core, 'node_modules/teleproto/Helpers.js'));
const {artifactDir} = buildPlugin({id: 'bulk_delete', packageRoot: path.resolve(__dirname, '../bulk_delete'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}

async function within(promise, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function fixture(options = {}) {
  let data = structuredClone(options.initial ?? {schemaVersion: 1, userDeleteMode: {}});
  const sent = [], deleted = [], tasks = [], calls = [];
  const client = {
    async getMe() {return {id: 1n};},
    async getMessages() {return [{id: 9, senderId: 1n}, {id: 8, senderId: 2n}];},
    async deleteMessages(chat, ids, settings) {deleted.push({chat, ids, settings});},
    async sendMessage(chat, value) {sent.push({chat, value}); return {id: 50};},
    async getEntity() {return {className: 'User'};},
    ...options.client,
  };
  const controller = new AbortController();
  const context = {
    signal: controller.signal,
    storage: {json() {return {
      async read() {return structuredClone(data);},
      async update(fn) {data = await fn(structuredClone(data)); return structuredClone(data);},
    };}},
    tasks: {run(name, fn) {tasks.push({name, fn}); return Promise.resolve();}},
    telegram: {withClient(fn) {return fn(client, controller.signal);}},
    log: {info() {}, error(event) {calls.push({type: 'log', event});}},
  };
  return {
    client, context, controller, sent, deleted, tasks, calls, data: () => data,
    run(args, message = {id: 10, chatId: '7', text: `.bd ${args.join(' ')}`, outgoing: true, raw: {chatId: '7'}}, prefix = '.') {
      return create().commands.bd.handle({message, args, command: 'bd', prefix}, context);
    },
  };
}

test('bd persists on/off and owns delayed cleanup', async () => {
  const f = fixture(); await f.run(['off']);
  assert.equal(f.data().userDeleteMode['1'], false);
  assert.match(f.sent[0].value.message, /关闭/);
  assert.match(f.tasks[0].name, /^bd:cleanup:/);
});

test('bd numeric mode deletes only own recent messages', async () => {
  const f = fixture(); await f.run(['2']);
  assert.deepEqual(f.deleted[0].ids, [10, 9]);
  assert.match(f.sent[0].value.message, /1 条/);
});

test('bd reply mode resolves the starting message before any range side effect', async () => {
  const reads = [];
  const f = fixture({client: {async getMessages(_chat, params) {
    reads.push(params);
    if (params.ids) return [];
    return [{id: 5, senderId: 1n}, {id: 10, senderId: 1n}];
  }}});
  await f.run([], {id: 10, chatId: '7', text: '.bd', outgoing: true, replyToId: 5, raw: {chatId: '7'}});
  assert.deepEqual(reads, [{ids: [5]}]);
  assert.deepEqual(f.deleted, []);
  assert.deepEqual(f.sent, []);
});

test('bd preserves the original missing-date compatibility in reply range collection', async () => {
  const f = fixture({client: {async getMessages(_chat, params) {
    if (params.ids) return [{id: 5, senderId: 2n}];
    throw new TypeError("Cannot read properties of undefined (reading 'date')");
  }}});
  await f.run([], {id: 10, chatId: '7', text: '.bd', outgoing: true, replyToId: 5, raw: {chatId: '7'}});
  assert.match(f.sent[0].value.message, /没有删除该范围内消息的权限/);
  assert.doesNotMatch(f.sent[0].value.message, /收集消息列表时出错/);
  assert.deepEqual(f.deleted, []);
});

test('bd exposes only a fixed collection error when native history lookup fails', async () => {
  const secret = 'sk-live-should-not-leak/etc/passwd';
  const f = fixture({client: {async getMessages(_chat, params) {
    if (params.ids) return [{id: 5, senderId: 2n}];
    const error = new Error(`BOT_TOKEN=${secret}`); error.name = secret;
    throw error;
  }}});
  await f.run([], {id: 10, chatId: '7', text: '.bd', outgoing: true, replyToId: 5, raw: {chatId: '7'}});
  assert.equal(f.sent[0].value.message, '❌ 收集消息列表时出错。');
  assert.equal(JSON.stringify({sent: f.sent, calls: f.calls}).includes(secret), false);
  assert.deepEqual(f.deleted, []);
});

test('bd uses an exact native integer when a synthetic envelope has no raw peer', async () => {
  const chats = [];
  const f = fixture({client: {
    async getMessages(chat) {chats.push(chat); return [{id: 9, senderId: 1n}];},
    async deleteMessages(chat, ids) {chats.push(chat); f.deleted.push({chat, ids});},
    async sendMessage(chat, value) {chats.push(chat); f.sent.push({chat, value}); return {id: 50};},
  }});
  await f.run(['1'], {id: 10, chatId: '9007199254740993', text: '.bd 1', outgoing: true});
  assert.ok(chats.length >= 2);
  assert.ok(chats.every(chat => chat.value === 9007199254740993n));
});

test('bd permission hint uses the active command prefix', async () => {
  const f = fixture({initial: {schemaVersion: 1, userDeleteMode: {'1': false}}, client: {
    async getMessages(_chat, params) {
      if (params.ids) return [{id: 5, senderId: 2n}];
      return [{id: 5, senderId: 2n}, {id: 10, senderId: 1n}];
    },
  }});
  await f.run([], {id: 10, chatId: '7', text: '🙂bd', outgoing: true, replyToId: 5, raw: {chatId: '7'}}, '🙂');
  assert.match(f.sent[0].value.message, /🙂bd on/);
  assert.doesNotMatch(f.sent[0].value.message, /\.bd on/);
});

test('real host resolves and serializes the self-permission RPC before deleting a range', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bulk-delete-wire-v2-')));
  const peer = new Api.PeerChannel({channelId: integer(10)});
  const deleted = [], wire = [];
  const client = {
    async getMe() {return {id: integer(1)};},
    async getMessages(_chat, params) {
      if (params.ids) return [{id: 5, senderId: integer(2)}];
      return [{id: 5, senderId: integer(2)}, {id: 10, senderId: integer(1)}];
    },
    async getEntity() {return {className: 'Channel'};},
    async invoke(request) {
      await request.resolve({async getInputEntity(value) {
        if (value instanceof Api.InputPeerSelf) return value;
        if (value instanceof Api.PeerChannel) return new Api.InputPeerChannel({channelId: value.channelId, accessHash: integer(99)});
        return value;
      }}, utils);
      wire.push({name: request.className, bytes: request.getBytes()});
      return {participant: {className: 'ChannelParticipantCreator'}};
    },
    async deleteMessages(_chat, ids) {deleted.push(ids);},
    async sendMessage() {assert.fail('successful range deletion must be silent');},
  };
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit() {}, async reply() {}, async invoke() {}, async getReply() {},
    async withClient(operation, signal) {return operation(client, signal);},
  }});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  await host.load(create());
  await host.dispatchPrimary({id: 10, chatId: '-10010', senderId: '1', outgoing: true, text: '.bd', replyToId: 5,
    raw: {id: 10, peerId: peer, className: 'Message'}});
  assert.deepEqual(wire.map(item => item.name), ['channels.GetParticipant']);
  assert.ok(wire[0].bytes.length > 0);
  assert.deepEqual(deleted, [[5, 10]]);
});

test('real host cancellation during history fetch prevents late delete and feedback', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bulk-delete-cancel-v2-')));
  const entered = deferred(), release = deferred();
  let activeSignal, deletes = 0, sends = 0;
  const client = {
    async getMe() {return {id: 1n};},
    async getMessages() {entered.resolve(); return release.promise;},
    async deleteMessages() {deletes++;},
    async sendMessage() {sends++; return {id: 50};},
  };
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit() {}, async reply() {}, async invoke() {}, async getReply() {},
    async withClient(operation, signal) {activeSignal = signal; return operation(client, signal);},
  }});
  t.after(async () => {
    release.resolve([]);
    await host.shutdown(1000);
    await fs.rm(root, {recursive: true, force: true});
  });
  await host.load(create());
  const work = host.dispatchPrimary({id: 10, chatId: '7', senderId: '1', outgoing: true, text: '.bd 1'});
  await within(entered.promise);
  const aborted = new Promise(resolve => {
    if (activeSignal.aborted) resolve();
    else activeSignal.addEventListener('abort', resolve, {once: true});
  });
  const unloading = host.unload('bulk_delete', 1000);
  await within(aborted);
  release.resolve([{id: 9, senderId: 1n}]);
  await within(Promise.allSettled([work]));
  const report = await within(unloading);
  assert.equal(report.completed, true);
  assert.equal(deletes, 0);
  assert.equal(sends, 0);
});

test('bd delayed cleanup releases abort listeners on completion and cancellation', async () => {
  const built = buildPlugin({id: 'bulk_delete', packageRoot: path.resolve(__dirname, '../bulk_delete'), entry: 'v2.ts'});
  const filename = path.join(built.artifactDir, 'index.cjs');
  const candidate = new Module(filename);
  candidate.filename = filename;
  candidate.paths = Module._nodeModulePaths(path.dirname(filename));
  candidate._compile(fsSync.readFileSync(filename, 'utf8') + '\nmodule.exports.delayForTest=sleep;', filename);
  const sleep = candidate.exports.delayForTest;
  const controller = new AbortController();
  for (let index = 0; index < 12; index++) await sleep(0, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const pending = sleep(60000, controller.signal), reason = new Error('cancelled');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(sleep(60000, controller.signal), error => error === reason);
});

test('bd delayed cleanup reports only a fixed safe failure event', async () => {
  const filename = path.join(artifactDir, 'index.cjs');
  const candidate = new Module(filename);
  candidate.filename = filename;
  candidate.paths = Module._nodeModulePaths(path.dirname(filename));
  candidate._compile(fsSync.readFileSync(filename, 'utf8') + '\nmodule.exports.removeLaterForTest=removeLater;', filename);
  const removeLater = candidate.exports.removeLaterForTest;
  const controller = new AbortController(), logged = deferred(), logs = [];
  const error = new Error('BOT_TOKEN=should-not-leak');
  error.name = 'sk-live-should-not-leak/etc/passwd';
  const context = {
    signal: controller.signal,
    tasks: {run(_name, operation) {return operation(controller.signal);}},
    telegram: {withClient(operation) {return operation({async deleteMessages() {throw error;}}, controller.signal);}},
    log: {error(...args) {logs.push(args); logged.resolve();}},
  };
  await removeLater(context, integer(7), [1], 0);
  await within(logged.promise);
  assert.deepEqual(logs, [['bulk_delete:cleanup_failed']]);
  assert.equal(JSON.stringify(logs).includes('should-not-leak'), false);
});
