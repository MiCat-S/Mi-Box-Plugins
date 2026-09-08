'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
let root, factory, Api, integer, manifest, prepared;
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
  prepared = await require(path.join(core, 'dist/v2/artifacts.js')).prepareArtifact(built.artifactDir);
  factory = () => prepared.create();
  factory();
  assert.equal(!!require.cache[protoPath], loaded);
  ({Api} = require(protoPath));
  ({returnBigInt: integer} = require(path.join(core, 'node_modules/teleproto/Helpers.js')));
});
test.after(async () => { prepared?.release(); test.mock.restoreAll(); if (root) await fs.rm(root, {recursive: true, force: true}); });
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
      async edit(message, text, opts, signal) { signal.throwIfAborted(); edits.push({message, text, opts}); await options.onEdit?.(message, text); },
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
  const f = await fixture(t, {groups: Array.from({length: 8}, (_, i) => channel(String(100 + i))), native: {invoke: async req => {
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
  assert.equal(f.mutations().length, 4);
  assert.equal(f.edits.length, 3);
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
test('a pending batch does not reject a new target with a global busy message', async t => {
  const entered = deferred(), finished = deferred();
  t.after(() => finished.resolve());
  const f = await fixture(t, {native: {invoke: async req => {
    if (req instanceof Api.channels.GetParticipant) return regularPermission(req);
    if (req instanceof Api.channels.EditBanned && req.participant.userId.toString() === '2') {
      entered.resolve(); await finished.promise;
    }
    return {offset: 0};
  }}});
  await f.host.dispatchPrimary({...envelope, text: '.sb 2'});
  await entered.promise;
  await f.run('.sb 3', {id: 10});
  assert.match(f.edits.at(-1).text, /成功 1/);
  assert.ok(f.mutations().some(req => req instanceof Api.channels.EditBanned && req.participant.userId.toString() === '3'));
  assert.doesNotMatch(f.edits.at(-1).text, /任务正在执行/);
  finished.resolve();
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
test('successful result emphasizes counts and omits empty failure sections', async t => {
  const f = await fixture(t);
  await f.run();
  const {text, opts} = f.edits.at(-1);
  assert.ok(text.includes('<b>成功 1</b>'));
  assert.ok(text.includes('<a href="tg://user?id=2">&lt;Target&amp;&gt;</a>'));
  assert.doesNotMatch(text, /失败 0|不支持 0|未完成原因/);
  assert.equal(opts.parseMode, 'html');
});
test('29 successes and four absent users render a compact Chinese summary', async t => {
  const groups = Array.from({length: 33}, (_, i) => channel(String(100 + i)));
  const f = await fixture(t, {groups, native: {invoke: async req => {
    if (req instanceof Api.channels.GetParticipant) return regularPermission(req);
    if (req instanceof Api.channels.EditBanned && Number(req.channel.channelId.toString()) >= 129) {
      throw new Error('USER_NOT_PARTICIPANT');
    }
    return {offset: 0};
  }}});
  await f.run('.sb 2', {chatId: '1'});
  const {text} = f.edits.at(-1);
  assert.ok(text.includes('<b>成功 29 · 失败 4</b>'));
  assert.match(text, /目标不在该群 · 4 个/);
  assert.match(text, /未清理（当前会话不适用）/);
  assert.doesNotMatch(text, /USER_NOT_PARTICIPANT|不支持 0/);
  assert.ok(text.split('\n').length <= 9);
});

test('batch permissions use managed dialog rights without a self lookup RPC', async t => {
  const f = await fixture(t, {native: {invoke: async req => {
    if (req instanceof Api.channels.GetParticipant) {
      if (req.participant instanceof Api.InputPeerSelf) throw new Error('self lookup unavailable');
      return regularPermission(req);
    }
    return {offset: 0};
  }}});
  await f.run('.sb 2');
  assert.match(f.edits.at(-1).text, /成功 1/);
  assert.equal(f.calls.filter(c => c.method === 'invoke' && c.args[0] instanceof Api.channels.GetParticipant &&
    c.args[0].participant instanceof Api.InputPeerSelf).length, 0);
});

test('batch uses at most four concurrent mutations and completes every managed group', async t => {
  const barrier = deferred();
  let active = 0, peak = 0;
  const f = await fixture(t, {groups: Array.from({length: 9}, (_, i) => channel(String(100 + i))), native: {invoke: async req => {
    if (req instanceof Api.channels.GetParticipant) return regularPermission(req);
    if (req instanceof Api.channels.EditBanned) {
      active++; peak = Math.max(peak, active);
      if (active === 4) barrier.resolve();
      await barrier.promise;
      await new Promise(setImmediate);
      active--;
    }
    return {offset: 0};
  }}});
  await f.run('.sb 2');
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(f.mutations().filter(req => req instanceof Api.channels.EditBanned).length, 9);
  assert.match(f.edits.at(-1).text, /成功 9/);
});

test('a displayed result awaiting Telegram acknowledgement does not block the next sb', async t => {
  const displayed = deferred(), acknowledged = deferred();
  t.after(() => acknowledged.resolve());
  const f = await fixture(t, {onEdit: async (message, text) => {
    if (message.id === 9 && /批量封禁结果/.test(text)) {
      displayed.resolve(); await acknowledged.promise;
    }
  }});
  await f.host.dispatchPrimary({...envelope, text: '.sb 2'});
  await displayed.promise;
  await f.run('.sb 3', {id: 10});
  assert.match(f.edits.at(-1).text, /成功 1/);
  assert.match(f.edits.at(-1).text, /user\?id=3/);
  acknowledged.resolve();
});

test('reply users without an input peer fall back to managed group resolution', async t => {
  const partial = new Api.User({id: integer(2), firstName: 'Partial', min: true});
  const f = await fixture(t, {reply: {id: 1, senderId: '2', raw: {sender: partial}}, native: {
    getEntity: async () => {throw new Error('cache miss');},
    getInputEntity: async target => {
      if (!(target instanceof Api.User) || target === partial) throw new Error('User without accessHash or min cannot be input');
      return peer(target.id.toString());
    },
  }});
  await f.run('.sb', {replyToId: 1});
  assert.match(f.edits.at(-1).text, /成功 1/);
  assert.ok(f.mutations().some(req => req instanceof Api.channels.EditBanned));
});

test('unexpected account failures identify their stage without exposing private error text', async t => {
  const f = await fixture(t, {native: {getMe: async () => {throw new Error('private-server-details');}}});
  await f.run('.sb 2');
  assert.match(f.edits.at(-1).text, /阶段：读取账号/);
  assert.doesNotMatch(JSON.stringify({edits: f.edits, logs: f.logs}), /private-server-details/);
});

test('replied users resolve by their source message when account user lookup is unavailable', async t => {
  const source = new Api.PeerChannel({channelId: integer(900)});
  const f = await fixture(t, {reply: {id: 71, chatId: '-100900', senderId: '2', raw: {peerId: source}}, native: {
    getEntity: async () => {throw new Error('user lookup unavailable');},
    getInputEntity: async target => {
      if (target === source) return new Api.InputPeerChannel({channelId: integer(900), accessHash: integer(99)});
      throw new Error('user lookup unavailable');
    },
  }});
  await f.run('.sb', {replyToId: 71});
  assert.match(f.edits.at(-1).text, /成功 1/);
  const request = f.mutations().find(req => req instanceof Api.channels.EditBanned);
  assert.ok(request.participant instanceof Api.InputPeerUserFromMessage);
  assert.equal(request.participant.msgId, 71);
  assert.equal(request.participant.peer.channelId.toString(), '900');
  assert.equal(request.participant.userId.toString(), '2');
  assert.ok(request.getBytes().length > 0);
  assert.equal(f.calls.filter(c => c.method === 'getEntity').length, 0);
});

test('basic group reply removal converts the message reference to InputUserFromMessage', async t => {
  const entity = new Api.Chat({id: integer(100), title: 'Basic', creator: true});
  const source = new Api.PeerChat({chatId: integer(100)});
  const f = await fixture(t, {entity, reply: {id: 72, senderId: '2', raw: {peerId: source}}, native: {
    getInputEntity: async target => {
      assert.equal(target, source);
      return new Api.InputPeerChat({chatId: integer(100)});
    },
  }});
  await f.run('.ban', {chatId: '-100', replyToId: 72});
  const request = f.mutations()[0];
  assert.ok(request instanceof Api.messages.DeleteChatUser);
  assert.ok(request.userId instanceof Api.InputUserFromMessage);
  assert.equal(request.userId.msgId, 72);
  assert.equal(request.userId.userId.toString(), '2');
  assert.ok(request.getBytes().length > 0);
  assert.match(f.edits.at(-1).text, /成功 1/);
});

test('numeric resolution continues after one managed group fails', async t => {
  const f = await fixture(t, {groups: [channel('100'), channel('200')], native: {
    getEntity: async () => {throw new Error('cache miss');},
    getInputEntity: async target => {
      if (target instanceof Api.User) return peer(target.id.toString());
      throw new Error('cache miss');
    },
    invoke: async req => {
      if (req instanceof Api.channels.GetParticipant) {
        if (req.participant instanceof Api.InputPeerUser && req.participant.accessHash.toString() === '0') {
          if (req.channel.channelId.toString() === '100') throw new Error('private lookup failure');
          return {participant: new Api.ChannelParticipant({userId: integer(2)}), users: [user()]};
        }
        return regularPermission(req);
      }
      return {offset: 0};
    },
  }});
  await f.run('.sb 2');
  assert.match(f.edits.at(-1).text, /成功 2/);
  assert.doesNotMatch(JSON.stringify({edits: f.edits, logs: f.logs}), /private lookup failure/);
});

test('exhausted numeric resolution reports canonical RPC codes and checked group count', async t => {
  const f = await fixture(t, {groups: [channel('100'), channel('200')], native: {
    getEntity: async () => {throw new Error('cache miss');},
    getInputEntity: async () => {throw new Error('cache miss');},
    invoke: async () => {throw Object.assign(new Error('private request contents'), {code: 400, errorMessage: 'PARTICIPANT_ID_INVALID'});},
  }});
  await f.run('.sb 2');
  assert.match(f.edits.at(-1).text, /已检查 2 个/);
  assert.match(f.edits.at(-1).text, /PARTICIPANT_ID_INVALID/);
  assert.equal(f.mutations().length, 0);
  assert.doesNotMatch(JSON.stringify({edits: f.edits, logs: f.logs}), /private request contents/);
});
