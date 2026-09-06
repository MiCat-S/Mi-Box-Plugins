'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
let root, factory, Api, integer, manifest;
const envelope = {id: 9, chatId: '-100100', senderId: '1', outgoing: true, text: '.ban 2'};
test.before(async () => {
  test.mock.method(globalThis, 'fetch', () => assert.fail('No live HTTP'));
  test.mock.method(require('node:net').Socket.prototype, 'connect', () => assert.fail('No live Telegram'));
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aban-build-')));
  await fs.mkdir(path.join(root, 'node_modules'));
  for (const [name, target] of [['telebox', core], ['teleproto', path.join(core, 'node_modules/teleproto')]]) {
    await fs.symlink(target, path.join(root, 'node_modules', name), 'dir');
  }
  const built = buildPlugin({id: 'aban', packageRoot: path.resolve(__dirname, '../aban'), entry: 'v2.ts', rootDir: root});
  manifest = built.manifest;
  const protoPath = require.resolve(path.join(core, 'node_modules/teleproto'));
  const loaded = !!require.cache[protoPath];
  factory = require(path.join(built.artifactDir, 'index.cjs')).default;
  factory();
  assert.equal(!!require.cache[protoPath], loaded);
  ({Api} = require(protoPath));
  ({returnBigInt: integer} = require(path.join(core, 'node_modules/teleproto/Helpers.js')));
});
test.after(async () => { test.mock.restoreAll(); if (root) await fs.rm(root, {recursive: true, force: true}); });
const user = (id = '2') => new Api.User({id: integer(id), accessHash: integer(30), firstName: '<Target&>'});
const channel = (id = '100', rights = {banUsers: true, deleteMessages: true}) =>
  new Api.Channel({id: integer(id), accessHash: integer(20), title: 'Group', megagroup: true,
    adminRights: new Api.ChatAdminRights(rights), photo: new Api.ChatPhotoEmpty(), date: 0});
const peer = id => new Api.InputPeerUser({userId: integer(id), accessHash: integer(30)});
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
};
async function fixture(t, options = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aban-test-')));
  const calls = [], edits = [], logs = [], folders = [];
  const entity = options.entity ?? channel();
  const base = {
    getMe: async () => user('1'),
    getEntity: async target => target?.toString().startsWith('-') ? entity : user(target?.toString().startsWith('@') ? '2' : target.toString()),
    getInputEntity: async target => peer(target.id?.toString() ?? target.toString()),
    async *iterDialogs({folder}) {
      folders.push(folder);
      for (const item of options.groups ?? [entity]) yield {entity: item};
    },
    invoke: async req => {
      if (req instanceof Api.channels.GetParticipant) {
        if (req.participant instanceof Api.InputPeerSelf) return {participant: new Api.ChannelParticipantAdmin({
          userId: integer(1), adminRights: new Api.ChatAdminRights(options.rights ?? {banUsers: true, deleteMessages: true})})};
        if (options.targetAbsent) throw new Error('USER_NOT_PARTICIPANT');
        return {participant: options.admin ? new Api.ChannelParticipantAdmin({
          userId: integer(2), adminRights: new Api.ChatAdminRights({banUsers: true})}) : new Api.ChannelParticipant({userId: integer(2)}),
          users: [user(options.numericId ?? '2')]};
      }
      if (req instanceof Api.messages.GetFullChat) return {fullChat: new Api.ChatFull({
        id: integer(100), participants: new Api.ChatParticipants({chatId: integer(100), version: 1,
          participants: [new Api.ChatParticipantCreator({userId: integer(1)}), new Api.ChatParticipant({userId: integer(2)})]})}), users: [user()]};
      if (req instanceof Api.channels.DeleteParticipantHistory) return {offset: 0};
      if (req instanceof Api.channels.EditBanned || req instanceof Api.messages.DeleteChatUser) return {};
      assert.fail('Unexpected RPC ' + req.className);
    },
  };
  Object.assign(base, options.native);
  const client = new Proxy({}, {get(_target, key) {
    if (key === 'then') return undefined;
    return (...args) => { calls.push({method: key, args}); return base[key](...args); };
  }});
  const host = new PluginHost({storageRoot: dir, prefixes: options.prefixes,
    logger: {info() {}, error(event, fields) { logs.push({event, fields}); }},
    telegram: {
      async edit(message, text, opts, signal) { signal.throwIfAborted(); edits.push({message, text, opts}); },
      async reply() { assert.fail('No extra messages'); },
      async getReply(_message, signal) { signal.throwIfAborted(); return options.reply; },
      async invoke() { assert.fail('Use scoped client'); },
      async withClient(fn, signal) { signal.throwIfAborted(); return fn(client, signal); },
    }});
  await host.load(factory());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    assert.deepEqual(await fs.readdir(dir), [], 'no disk cache or settings needed');
    await fs.rm(dir, {recursive: true, force: true});
  });
  return {host, calls, edits, logs, folders,
    mutations: () => calls.filter(c => c.method === 'invoke' &&
      (c.args[0] instanceof Api.channels.EditBanned || c.args[0] instanceof Api.messages.DeleteChatUser ||
       c.args[0] instanceof Api.channels.DeleteParticipantHistory)).map(c => c.args[0]),
    run: async (text = '.ban 2', fields = {}) => {
      const start = edits.length;
      await host.dispatchPrimary({...envelope, text, ...fields});
      if (/^\.(sb|unsb)\b/.test(text)) {
        for (let i = 0; i < 1000; i++) {
          if (edits.slice(start).some(e => /结果|操作未完成|正在执行/.test(e.text))) return;
          await new Promise(setImmediate);
        }
        assert.fail('Batch did not finish');
      }
    }};
}
test('pure factory exposes all nine commands with edited-message protection', () => {
  const p = factory();
  assert.deepEqual(Object.keys(p.commands).sort(), ['aban', 'ban', 'kick', 'mute', 'refresh', 'sb', 'unban', 'unmute', 'unsb']);
  assert.ok(Object.values(p.commands).every(c => c.ignoreEdited));
  assert.deepEqual(manifest.imports, ['node:timers/promises', 'telebox/sdk', 'teleproto', 'teleproto/Helpers.js']);
});
test('help uses rich text/current prefix and makes no native calls', async t => {
  const f = await fixture(t, {prefixes: ['!!']});
  await f.run('!!aban');
  assert.equal(f.calls.length, 0);
  assert.match(f.edits[0].text, /!!sb/);
  assert.equal(f.edits[0].opts.parseMode, 'html');
});
test('incoming and edited commands never mutate members', async t => {
  const f = await fixture(t);
  await f.run('.ban 2', {outgoing: false});
  await f.run('.ban 2', {edited: true});
  assert.equal(f.calls.length, 0);
});
for (const action of ['ban', 'kick', 'unban', 'mute', 'unmute']) {
  test(action + ' preserves restriction semantics', async t => {
    const f = await fixture(t);
    await f.run('.' + action + ' 2');
    const mutations = f.mutations().filter(r => r instanceof Api.channels.EditBanned);
    assert.equal(mutations.length, action === 'kick' ? 2 : 1);
    const r = mutations[0].bannedRights;
    assert.equal(!!r.viewMessages, ['ban', 'kick'].includes(action));
    assert.equal(!!r.sendMessages, ['ban', 'kick', 'mute'].includes(action));
    if (action === 'kick') assert.equal(!!mutations[1].bannedRights.viewMessages, false);
    assert.match(f.edits.at(-1).text, /成功 1/);
    assert.ok(f.edits.at(-1).text.includes('&lt;Target&amp;&gt;'));
  });
}
test('reply mute 5m parses duration independently of target', async t => {
  const f = await fixture(t, {reply: {...envelope, senderId: '2'}});
  const before = Math.floor(Date.now() / 1000);
  await f.run('.mute 5m', {replyToId: 1});
  const until = f.mutations()[0].bannedRights.untilDate;
  assert.ok(until >= before + 300 && until <= before + 301);
  assert.match(f.edits.at(-1).text, /300 秒/);
});
test('invalid duration and malformed target do not mutate', async t => {
  for (const text of ['.mute 2 5x', '.mute 2 1s', '.mute 2 999d', '.ban -10012', '.ban 2 garbage']) {
    const f = await fixture(t);
    await f.run(text);
    assert.equal(f.mutations().length, 0);
    assert.match(f.edits.at(-1).text, /参数无效|时长/);
  }
});
test('admin target requires explicit true before any deletion or ban', async t => {
  const f = await fixture(t, {admin: true, reply: {...envelope, senderId: '2'}});
  await f.run('.sb', {replyToId: 1});
  assert.equal(f.mutations().length, 0);
  assert.match(f.edits.at(-1).text, /追加 true/);
  await f.run('.sb true', {replyToId: 1});
  assert.ok(f.mutations().some(r => r instanceof Api.channels.EditBanned));
});
test('deleteMessages alone does not grant ban permission', async t => {
  const f = await fixture(t, {rights: {deleteMessages: true}});
  await f.run();
  assert.equal(f.mutations().length, 0);
  assert.match(f.edits.at(-1).text, /无封禁权限/);
});
test('permission lookup errors fail closed and sanitize messages', async t => {
  const f = await fixture(t, {native: {invoke: async () => { throw new Error('secret-token'); }}});
  await f.run();
  assert.equal(f.mutations().length, 0);
  assert.doesNotMatch(JSON.stringify([f.edits, f.logs]), /secret-token/);
});
test('self target rejected even with true', async t => {
  const f = await fixture(t);
  await f.run('.sb 1 true');
  assert.equal(f.mutations().length, 0);
});
test('numeric IDs preserve exact precision and fall back to managed group resolution', async t => {
  const id = '9007199254740993';
  const f = await fixture(t, {numericId: id, native: {
    getEntity: async target => {
      if (target.toString().startsWith('-')) return channel();
      throw new Error('cache miss');
    },
    getInputEntity: async target => {
      if (target instanceof Api.User) return peer(target.id.toString());
      throw new Error('cache miss');
    },
  }});
  await f.run('.ban ' + id);
  assert.equal(f.mutations()[0].participant.userId.toString(), id);
});
test('basic group kick/ban removes members and mute/unban report unsupported', async t => {
  const entity = new Api.Chat({id: integer(100), title: 'Basic', creator: true});
  const f = await fixture(t, {entity});
  for (const action of ['kick', 'ban']) {
    await f.run('.' + action + ' 2', {chatId: '-100'});
    assert.match(f.edits.at(-1).text, /基本群移出 1/);
  }
  assert.equal(f.mutations().length, 2);
  assert.ok(f.mutations().every(r => r instanceof Api.messages.DeleteChatUser));
  for (const action of ['mute', 'unmute', 'unban']) {
    await f.run('.' + action + ' 2', {chatId: '-100'});
    assert.match(f.edits.at(-1).text, /不支持 1/);
  }
  assert.equal(f.mutations().length, 2);
});
test('managed groups include archived dialogs, deduplicate and refresh cache', async t => {
  const f = await fixture(t, {groups: [channel(), channel('200'), channel('300', {deleteMessages: true})]});
  await f.run('.sb 2');
  assert.deepEqual(f.folders, [0, 1]);
  assert.match(f.edits.at(-1).text, /成功 2/);
  await f.run('.unsb 2');
  assert.deepEqual(f.folders, [0, 1]);
  await f.run('.refresh');
  assert.deepEqual(f.folders, [0, 1, 0, 1]);
  assert.match(f.edits.at(-1).text, /2/);
});
test('absent members can be pre-banned, but inaccessible groups fail closed', async t => {
  const f = await fixture(t, {targetAbsent: true});
  await f.run('.ban 2');
  assert.match(f.edits.at(-1).text, /成功 1/);
});
test('kick partial completion reports remaining ban', async t => {
  let count = 0;
  const g = await fixture(t, {native: {invoke: async req => {
    if (req instanceof Api.channels.GetParticipant) return {participant: new Api.ChannelParticipantCreator({userId: integer(1)})};
    if (req instanceof Api.channels.EditBanned && ++count === 2) throw new Error('CHAT_ADMIN_REQUIRED');
    return {};
  }}});
  await g.run('.kick 2 true');
  assert.match(g.edits.at(-1).text, /已封禁，但解除失败/);
});
test('unload waits for in-flight mutation and prevents subsequent group operations', async t => {
  const entered = deferred(), finished = deferred();
  const f = await fixture(t, {groups: [channel(), channel('200')], native: {invoke: async req => {
    if (req instanceof Api.channels.GetParticipant) return {participant: req.participant instanceof Api.InputPeerSelf
      ? new Api.ChannelParticipantCreator({userId: integer(1)}) : new Api.ChannelParticipant({userId: integer(2)})};
    if (req instanceof Api.channels.EditBanned) { entered.resolve(); return finished.promise; }
    assert.fail('Unexpected request');
  }}});
  await f.host.dispatchPrimary({...envelope, text: '.sb 2'});
  await entered.promise;
  assert.equal((await f.host.unload('aban', 5)).completed, false);
  finished.resolve({});
  assert.equal((await f.host.unload('aban', 1000)).completed, true);
  assert.equal(f.mutations().length, 1);
  assert.equal(f.edits.length, 1);
});
function regularPermission(req) {
  return {participant: req.participant instanceof Api.InputPeerSelf
    ? new Api.ChannelParticipantCreator({userId: integer(1)}) : new Api.ChannelParticipant({userId: integer(2)})};
}
test('batch partial failure counts correctly and does not delete history after failed ban', async t => {
  const f = await fixture(t, {groups: [channel(), channel('200')], native: {invoke: async req => {
    if (req instanceof Api.channels.GetParticipant) return regularPermission(req);
    if (req instanceof Api.channels.EditBanned) {
      if (req.channel.channelId.toString() === '100') throw new Error('CHAT_ADMIN_REQUIRED secret');
      return {};
    }
    assert.fail('Must not delete history after failed ban');
  }}});
  await f.run('.sb 2');
  assert.match(f.edits.at(-1).text, /成功 1 · 失败 1/);
  assert.match(f.edits.at(-1).text, /未清理/);
  assert.doesNotMatch(JSON.stringify(f.edits), /secret/);
});
test('history cleanup follows all offsets', async t => {
  let history = 0;
  const f = await fixture(t, {native: {invoke: async req => {
    if (req instanceof Api.channels.GetParticipant) return regularPermission(req);
    if (req instanceof Api.channels.DeleteParticipantHistory) return {offset: ++history === 1 ? 10 : 0};
    return {};
  }}});
  await f.run();
  assert.equal(history, 2);
  assert.match(f.edits.at(-1).text, /已清理/);
});
test('short flood wait retries once; long waits remain visible failures', async t => {
  for (const seconds of [0, 10]) {
    let attempts = 0;
    const f = await fixture(t, {native: {invoke: async req => {
      if (req instanceof Api.channels.GetParticipant) return regularPermission(req);
      if (req instanceof Api.channels.EditBanned && ++attempts === 1) {
        throw Object.assign(new Error('FLOOD_WAIT_' + seconds), {seconds});
      }
      return {offset: 0};
    }}});
    await f.run('.unban 2');
    assert.equal(attempts, seconds === 0 ? 2 : 1);
    assert.match(f.edits.at(-1).text, seconds === 0 ? /成功 1/ : /失败 1/);
  }
});
test('duplicate batch commands are rejected while accepted work is pending', async t => {
  const entered = deferred(), finished = deferred();
  const f = await fixture(t, {native: {invoke: async req => {
    if (req instanceof Api.channels.GetParticipant) return regularPermission(req);
    if (req instanceof Api.channels.EditBanned) { entered.resolve(); await finished.promise; }
    return {offset: 0};
  }}});
  await f.host.dispatchPrimary({...envelope, text: '.unsb 2'});
  await entered.promise;
  await f.run('.sb 2', {id: 10});
  assert.match(f.edits.at(-1).text, /正在执行/);
  finished.resolve();
  // Drain the tracked operation without starting another command.
  for (let i = 0; i < 1000 && !f.edits.some(e => /结果/.test(e.text)); i++) await new Promise(setImmediate);
  assert.equal(f.mutations().length, 1);
});
test('50 load/unload cycles retain no tasks or cache files', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 50; i++) {
    await f.run('.refresh');
    assert.equal((await f.host.unload('aban', 1000)).completed, true);
    assert.equal(f.host.snapshot().commands, 0);
    if (i < 49) await f.host.load(factory());
  }
  assert.equal(f.folders.length, 100);
});
