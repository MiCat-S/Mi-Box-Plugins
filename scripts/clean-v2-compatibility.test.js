'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const timers = require('node:timers/promises');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const create = require(path.join(buildPlugin({id: 'clean', packageRoot: path.resolve(__dirname, '../clean'), entry: 'v2.ts'}).artifactDir, 'index.cjs')).default;

const message = (text, extra = {}) => ({id: 19, chatId: '-1009007199254740993', text, outgoing: true,
  raw: {isGroup: true, peerId: 'peer'}, ...extra});
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

function fixture(client) {
  const edits = [], logs = [], tasks = [];
  const signal = new AbortController().signal;
  const ctx = {
    signal,
    log: {info(event, fields) {logs.push({level: 'info', event, fields});}, error(event, fields) {logs.push({level: 'error', event, fields});}},
    tasks: {run(label, fn) {tasks.push({label, fn}); return Promise.resolve();}},
    telegram: {async edit(_message, text) {edits.push(text);}, async withClient(operation) {return operation(client, signal);}},
  };
  const run = args => create().commands.clean.handle({message: message(`.clean ${args.join(' ')}`), args, prefix: '.', command: 'clean'}, ctx);
  return {ctx, edits, logs, tasks, run};
}

async function realHostFixture(t, client) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clean-cancel-'))), edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(_message, text) {edits.push(text);}, async reply() {}, async invoke() {}, async getReply() {},
    async withClient(operation, signal) {return operation(client, signal);},
  }});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  await host.load(create());
  return {host, edits, dispatch: text => host.dispatchPrimary(message(text))};
}

test('CLEAN-COMPAT-00 command help is complete and unknown top-level input is identified', async () => {
  const f = fixture({});
  await f.run([]);
  for (const section of ['功能概述', '命令列表', '智能清理模式', '数据统计', '权限要求']) assert.match(f.edits.at(-1), new RegExp(section));
  await f.run(['unknown<&']);
  assert.match(f.edits.at(-1), /未知子命令: unknown&lt;&amp;/);
});

test('CLEAN-COMPAT-01 a primary dialog scan failure is reported without leaking details', async () => {
  const secret = 'tg-secret-DEADBEEF /etc/telebox/session';
  const f = fixture({async *iterDialogs({folder}) {if (folder === 0) throw new Error(secret);}});
  await f.run(['deleted', 'pm']);
  assert.equal(f.edits.at(-1), '❌ <b>操作失败:</b> 未知错误');
  assert.deepEqual(f.logs, [{level: 'error', event: 'clean:command_failed',
    fields: {chatId: '-1009007199254740993', messageId: 19}}]);
  assert.doesNotMatch(JSON.stringify({edits: f.edits, logs: f.logs}), /tg-secret|\/etc\/telebox/);
});

test('CLEAN-COMPAT-02 an archive scan failure remains non-fatal and sanitized', async () => {
  const user = {className: 'User', deleted: true, id: 9007199254740993n};
  const f = fixture({async *iterDialogs({folder}) {if (folder === 1) throw new Error('private archive token');
    yield {isUser: true, entity: user, inputEntity: 'deleted-user'};}});
  await f.run(['deleted', 'pm']);
  assert.match(f.edits.at(-1), /共找到 <code>1<\/code>/);
  assert.match(f.edits.at(-1), /9007199254740993/);
  assert.deepEqual(f.logs, [{level: 'error', event: 'clean:archive_scan_failed',
    fields: {chatId: '-1009007199254740993', messageId: 19}}]);
  assert.doesNotMatch(JSON.stringify(f.logs), /private archive token/);
});

function blockedClient({targets = [], deleteError} = {}) {
  const deleted = [], calls = [];
  return {deleted, calls,
    async getEntity() {return {className: 'Channel', id: 7n, megagroup: true};},
    async getInputEntity(value) {return value;}, async getMe() {return {id: 1n};},
    async invoke(request) {
      const name = request.className ?? request.constructor.name;
      calls.push(name);
      if (name.includes('GetParticipants')) return {users: targets.map(item => item.user).filter(Boolean), participants: targets.map(item => item.participant)};
      if (name.includes('GetParticipant')) return {participant: {className: 'ChannelParticipantCreator'}};
      return {};
    },
    async deleteMessages(peer, ids, options) {if (deleteError) throw new Error(deleteError); deleted.push({peer, ids, options});},
  };
}

test('CLEAN-COMPAT-03 an empty blocked-member result keeps the original managed three-second cleanup', async t => {
  const waits = [];
  t.mock.method(timers, 'setTimeout', async delay => {waits.push(delay);});
  const client = blockedClient(), f = fixture(client);
  await f.run(['blocked', 'member']);
  assert.match(f.edits.at(-1), /没有找到需要解封的实体/);
  assert.equal(f.tasks.length, 1);
  await f.tasks[0].fn(f.ctx.signal);
  assert.deepEqual(waits, [3000]);
  assert.deepEqual(client.deleted.map(item => ({ids: item.ids, options: item.options})), [{ids: [19], options: {revoke: true}}]);
});

test('CLEAN-COMPAT-04 a completed unblock keeps the original managed five-second cleanup', async t => {
  const waits = [];
  t.mock.method(timers, 'setTimeout', async delay => {waits.push(delay);});
  const targets = [
    {user: {className: 'User', id: 2n}, participant: {peer: {className: 'PeerUser', userId: 2n}, kickedBy: 1n}},
    {participant: {peer: {className: 'PeerChannel', channelId: 3n}, kickedBy: 1n}},
    {participant: {peer: {className: 'PeerChat', chatId: 4n}, kickedBy: 1n}},
  ];
  const client = blockedClient({targets}), f = fixture(client);
  await f.run(['blocked', 'member']);
  assert.match(f.edits.at(-1), /👤 用户: 1 📢 频道: 1 💬 群组: 1/);
  assert.match(f.edits.at(-1), /成功: <code>3<\/code>/);
  assert.equal(f.tasks.length, 1);
  await f.tasks[0].fn(f.ctx.signal);
  assert.deepEqual(waits, [500, 500, 500, 5000]);
  assert.equal(client.deleted.length, 1);
});

test('CLEAN-COMPAT-05 receipt cleanup failures expose only fixed event and safe ids', async t => {
  t.mock.method(timers, 'setTimeout', async () => {});
  const client = blockedClient({deleteError: 'private-delete-secret'}), f = fixture(client);
  await f.run(['blocked', 'member']);
  await f.tasks[0].fn(f.ctx.signal);
  assert.deepEqual(f.logs, [{level: 'error', event: 'clean:receipt_cleanup_failed',
    fields: {chatId: '-1009007199254740993', messageId: 19}}]);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-delete-secret/);
});

test('CLEAN-COMPAT-06 smart blocked-PM cleanup skips risky accounts and reports totals', async t => {
  t.mock.method(timers, 'setTimeout', async () => {});
  const users = [{id: 1n, bot: true}, {id: 2n, scam: true}, {id: 3n}];
  const unblocked = [];
  const client = {async invoke(request) {
    const name = request.className ?? request.constructor.name;
    if (name.includes('GetBlocked')) return {className: 'contacts.BlockedSlice', count: 3, users};
    if (name.includes('Unblock')) {unblocked.push(String(request.id.id)); return {};}
    throw new Error('unexpected request');
  }};
  const f = fixture(client);
  await f.run(['blocked', 'pm']);
  assert.deepEqual(unblocked, ['3']);
  assert.match(f.edits.at(-1), /总计用户: 3/);
  assert.match(f.edits.at(-1), /成功清理: 1/);
  assert.match(f.edits.at(-1), /跳过处理: 2/);
  assert.match(f.edits.at(-1), /清理模式: 智能清理/);
});

test('CLEAN-COMPAT-07 unloading cancels a pending receipt cleanup before deletion', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clean-compat-'))), deleted = [];
  const client = blockedClient();
  client.deleteMessages = async (...args) => {deleted.push(args);};
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit() {}, async reply() {}, async invoke() {}, async getReply() {},
    async withClient(operation, signal) {return operation(client, signal);},
  }});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  await host.load(create());
  await host.dispatchPrimary(message('.clean blocked member'));
  assert.equal((await host.unload('clean', 1000)).completed, true);
  await new Promise(setImmediate);
  assert.deepEqual(deleted, []);
});

test('CLEAN-CANCEL-01 cancellation after the first deleted-member ban performs no unban', async t => {
  const entered = deferred(), release = deferred(); let edits = 0;
  const client = {
    async getEntity() {return {className: 'Channel', id: 7n};}, async getInputEntity(value) {return value;},
    async getMe() {return {id: 1n};}, async *iterParticipants() {yield {className: 'User', deleted: true, id: 2n};},
    async invoke(request) {const name = request.className ?? request.constructor.name;
      if (name.includes('GetParticipant')) return {participant: {className: 'ChannelParticipantCreator'}};
      if (name.includes('EditBanned')) {edits++; if (edits === 1) {entered.resolve(); await release.promise;} return {};}
      throw new Error(`unexpected ${name}`);},
  };
  const f = await realHostFixture(t, client), running = f.dispatch('.clean deleted member rm');
  await entered.promise; const unloading = f.host.unload('clean', 1000); release.resolve();
  await running; assert.equal((await unloading).completed, true); assert.equal(edits, 1);
});

test('CLEAN-CANCEL-02 cancellation after a blocked-PM page performs no next-page request', async t => {
  const entered = deferred(), release = deferred(); let pages = 0, unblocks = 0;
  const client = {async invoke(request) {const name = request.className ?? request.constructor.name;
    if (name.includes('GetBlocked')) {pages++; entered.resolve(); await release.promise;
      return {className: 'contacts.BlockedSlice', count: 200, users: Array.from({length: 100}, (_, id) => ({id: BigInt(id + 1)}) )};}
    if (name.includes('Unblock')) {unblocks++; return {};}
    throw new Error(`unexpected ${name}`);}};
  const f = await realHostFixture(t, client), running = f.dispatch('.clean blocked pm');
  await entered.promise; const unloading = f.host.unload('clean', 1000); release.resolve();
  await running; assert.equal((await unloading).completed, true); assert.equal(pages, 1); assert.equal(unblocks, 0);
});

test('CLEAN-CANCEL-03 cancellation after a blocked-member page performs no next-page request', async t => {
  const entered = deferred(), release = deferred(); let pages = 0;
  const participant = id => ({peer: {className: 'PeerUser', userId: BigInt(id)}, kickedBy: 1n});
  const client = {
    async getEntity() {return {className: 'Channel', id: 7n};}, async getInputEntity(value) {return value;}, async getMe() {return {id: 1n};},
    async invoke(request) {const name = request.className ?? request.constructor.name;
      if (name.includes('GetParticipants')) {pages++; entered.resolve(); await release.promise; return {users: [], participants: Array.from({length: 200}, (_, id) => participant(id + 1))};}
      if (name.includes('GetParticipant')) return {participant: {className: 'ChannelParticipantCreator'}};
      throw new Error(`unexpected ${name}`);},
  };
  const f = await realHostFixture(t, client), running = f.dispatch('.clean blocked member');
  await entered.promise; const unloading = f.host.unload('clean', 1000); release.resolve();
  await running; assert.equal((await unloading).completed, true); assert.equal(pages, 1);
});

test('CLEAN-CANCEL-04 archive cancellation performs no deleted-dialog removal', async t => {
  const entered = deferred(), release = deferred(); let deletes = 0;
  const client = {
    async *iterDialogs({folder}) {if (folder === 0) {yield {isUser: true, entity: {className: 'User', deleted: true, id: 2n}, inputEntity: 'u'}; return;}
      entered.resolve(); await release.promise;},
    async deleteDialog() {deletes++;},
  };
  const f = await realHostFixture(t, client), running = f.dispatch('.clean deleted pm rm');
  await entered.promise; const unloading = f.host.unload('clean', 1000); release.resolve();
  await running; assert.equal((await unloading).completed, true); assert.equal(deletes, 0);
});
