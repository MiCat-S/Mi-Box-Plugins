'use strict';
// Behavioral compatibility tests for admin_board ABO-01..05. Everything runs
// against a simulated Telegram client using real Teleproto entity/request classes;
// no message, seat or admin right is touched on the live network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {Api, utils} = require(path.join(core, 'node_modules/teleproto'));
const {returnBigInt: bi} = require(path.join(core, 'node_modules/teleproto/Helpers.js'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

let create;
test.before(() => {
  const built = buildPlugin({id: 'admin_board', packageRoot: path.resolve(__dirname, '../admin_board'), entry: 'v2.ts', rootDir: core});
  create = require(path.join(built.artifactDir, 'index.cjs')).default;
});

const adminParticipant = (rank) => ({className: 'ChannelParticipantAdmin', rank});
const creatorParticipant = () => ({className: 'ChannelParticipantCreator'});
const user = ({id, firstName = 'U', lastName, username, bot = false, participant}) => {
  const entity = new Api.User({id: bi(id), accessHash: bi(1), firstName, ...(lastName ? {lastName} : {}), ...(username ? {username} : {}), bot});
  if (participant) entity.participant = participant;
  return entity;
};
const channel = (id, title, username) => new Api.Channel({id: bi(id), accessHash: bi(7), title, megagroup: true, ...(username ? {username} : {})});
const basicChat = (id, title) => ({className: 'Chat', id: bi(id), title});
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const target = options.target ?? channel(77, 'Team', 'team');
  const users = options.users ?? [
    user({id: '1', firstName: 'Owner', participant: creatorParticipant()}),
    user({id: '2', firstName: 'Normal', participant: adminParticipant('A')}),
  ];
  const state = new Map();
  if (options.cache) state.set('avg_cache.json', {schemaVersion: 1, values: clone(options.cache)});
  if (options.locks) state.set('seat_locks.json', {schemaVersion: 1, lockedSeats: clone(options.locks)});
  const controller = new AbortController();
  const edits = [], replies = [], invokes = [], calls = [];
  const client = {
    async getEntity(value) {
      if (value && typeof value === 'object' && (value === target || value.className === 'Channel' || value.className === 'Chat')) { calls.push({method: 'getEntity', value: '<target>'}); return target; }
      const key = String(value);
      calls.push({method: 'getEntity', value: key});
      if (key === String(target.id)) return target;
      if (options.getEntityFails?.includes(key)) throw new Error(options.getEntityError ?? 'PEER_ID_INVALID');
      if (key.startsWith('@')) {
        if (target.username && `@${target.username}` === key) return target;
        const found = users.find(candidate => candidate.username && `@${candidate.username}` === key);
        if (found) return found;
        throw new Error('USERNAME_NOT_OCCUPIED');
      }
      const found = users.find(candidate => String(candidate.id) === key);
      return found ?? target;
    },
    async getParticipants(entity, params = {}) {
      calls.push({method: 'getParticipants', params});
      if (options.onGetParticipants) { const result = await options.onGetParticipants(entity, params); if (result !== undefined) return result; }
      if (params.search) return users.filter(candidate => (candidate.username || '').toLowerCase() === params.search.toLowerCase());
      return users;
    },
    async getInputEntity(value) {
      calls.push({method: 'getInputEntity', value: String(value?.id ?? value)});
      if (options.onGetInputEntity) await options.onGetInputEntity(value, calls.length);
      if (value && value.className === 'User') return new Api.InputPeerUser({userId: value.id, accessHash: bi(1)});
      if (value && value.className === 'Channel') return new Api.InputPeerChannel({channelId: value.id, accessHash: bi(7)});
      if (value && value.className === 'Chat') return new Api.InputPeerChat({chatId: value.id});
      return value;
    },
    async getMessages(_entity, params = {}) {
      calls.push({method: 'getMessages'});
      const id = String(params.fromUser?.id ?? '');
      const date = options.lastDates?.[id] ?? 100;
      return [{date}];
    },
    async invoke(request) {
      invokes.push(request);
      calls.push({method: 'invoke', className: request?.className});
      if (options.wire) {
        await request.resolve({getInputEntity: async (value) => {
          if (value && value.className === 'Channel') return new Api.InputPeerChannel({channelId: value.id, accessHash: bi(7)});
          if (value && value.className === 'Chat') return new Api.InputPeerChat({chatId: value.id});
          if (value && value.className === 'User') return new Api.InputPeerUser({userId: value.id, accessHash: bi(1)});
          return value;
        }}, utils);
        request.getBytes();
      }
      if (options.onInvoke) { const result = await options.onInvoke(request, calls.length); if (result !== undefined) return result; }
      if (request instanceof Api.messages.Search) {
        const id = String(request.fromId?.userId ?? '');
        return {count: options.searchCounts?.[id] ?? 0};
      }
      if (request instanceof Api.channels.GetParticipants) return options.channelParticipants ?? {users, participants: users.map(() => ({}))};
      return {};
    },
  };
  const ctx = {
    signal: controller.signal,
    log: {info() {}, error() {}},
    storage: {json(name, defaults) {
      if (!state.has(name)) state.set(name, clone(defaults));
      return {
        read: async () => clone(state.get(name)),
        update: async mutator => { const next = await mutator(clone(state.get(name))); state.set(name, clone(next)); return clone(state.get(name)); },
      };
    }},
    telegram: {
      edit: async (_message, text) => { edits.push(text); },
      reply: async (_message, text) => { replies.push(text); },
      withClient: async operation => { controller.signal.throwIfAborted(); return operation(client, controller.signal); },
    },
  };
  const definition = create();
  const run = async (text) => {
    const args = text.replace(/^\.admin_board\b\s*/, '').trim().split(/\s+/).filter(Boolean);
    await definition.commands.admin_board.handle({message: {id: 1, chatId: String(target.id), text, outgoing: true, raw: {peerId: target}}, command: 'admin_board', prefix: '.', args}, ctx);
  };
  const savedLocks = () => state.get('seat_locks.json')?.lockedSeats?.[String(target.id)] ?? [];
  const editAdmins = () => invokes.filter(request => request instanceof Api.channels.EditAdmin);
  const editChatAdmins = () => invokes.filter(request => request instanceof Api.messages.EditChatAdmin);
  return {run, ctx, controller, target, users, state, edits, replies, invokes, calls, savedLocks, editAdmins, editChatAdmins};
}

// ---------------------------------------------------------------------------
// ABO-01: creator filtering happens before slicing the tail
// ---------------------------------------------------------------------------
test('ABO-01 rm selects the lowest non-creator, never the creator', async () => {
  const f = fixture({
    users: [user({id: '1', firstName: 'Owner', participant: creatorParticipant()}),
      user({id: '2', firstName: 'Normal', participant: adminParticipant('A')})],
    searchCounts: {'1': 0, '2': 7},
  });
  await f.run('.admin_board rm 1');
  const demoted = f.editAdmins();
  assert.equal(demoted.length, 1, 'exactly one admin is demoted');
  assert.equal(String(demoted[0].userId.userId), '2', 'the non-creator is demoted');
  assert.ok(!f.calls.some(call => call.method === 'invoke' && call.className === 'channels.EditAdmin' && String(call.value) === '1'));
  assert.match(f.edits.at(-1), /已下掉/);
});

test('ABO-01 an all-creator chat reports nothing to do', async () => {
  const f = fixture({users: [
    user({id: '1', firstName: 'Owner1', participant: creatorParticipant()}),
    user({id: '2', firstName: 'Owner2', participant: creatorParticipant()}),
  ]});
  await f.run('.admin_board rm 1');
  assert.equal(f.editAdmins().length, 0);
  assert.match(f.edits.at(-1), /无需处理/);
});

test('ABO-01 tail still lists creators even though rm excludes them', async () => {
  const f = fixture({users: [
    user({id: '1', firstName: 'Owner', participant: creatorParticipant()}),
    user({id: '2', firstName: 'Normal', participant: adminParticipant('A')}),
  ], searchCounts: {'1': 0, '2': 7}});
  await f.run('.admin_board tail 1');
  const page = f.edits.at(-1);
  assert.match(page, /Owner/, 'creator remains eligible for the tail list');
  assert.doesNotMatch(page, /Normal/, 'tail shows only the lowest N');
});

// ---------------------------------------------------------------------------
// ABO-02: identifier parsing, fallback resolution and exact IDs
// ---------------------------------------------------------------------------
test('ABO-02 comma plus spaces stays a two-user list, full-width comma too', async () => {
  const alice = user({id: '1001', firstName: 'Alice', username: 'alice', participant: adminParticipant('A')});
  const bobby = user({id: '1002', firstName: 'Bobby', username: 'bobby', participant: adminParticipant('A')});
  const f = fixture({users: [alice, bobby]});
  await f.run('.admin_board lock @alice, @bobby');
  assert.deepEqual(f.savedLocks().sort(), ['1001', '1002'], 'both users lock in the current chat');

  const g = fixture({users: [alice, bobby]});
  await g.run('.admin_board unlock @alice，@bobby');
  assert.deepEqual(g.savedLocks(), [], 'full-width comma parses the same way');
});

test('ABO-02 explicit trailing target is consumed without eating the last username', async () => {
  const alice = user({id: '1001', firstName: 'Alice', username: 'alice', participant: adminParticipant('A')});
  const f = fixture({users: [alice]});
  await f.run('.admin_board lock @alice @team');
  assert.deepEqual(f.savedLocks(), ['1001']);
  assert.ok(f.calls.some(call => call.method === 'getEntity' && call.value === '@team'), 'target resolved');
});

test('ABO-02 duplicate and bad identifiers deduplicate or write nothing', async () => {
  const alice = user({id: '1001', firstName: 'Alice', username: 'alice', participant: adminParticipant('A')});
  const f = fixture({users: [alice]});
  await f.run('.admin_board lock @Alice, @alice');
  assert.deepEqual(f.savedLocks(), ['1001'], 'case-insensitive username dedupe');

  const before = f.calls.length;
  await f.run('.admin_board lock not-a-user!');
  assert.deepEqual(f.savedLocks(), ['1001'], 'bad input writes nothing');
  assert.equal(f.calls.length, before, 'bad input performs no RPC');
  assert.match(f.edits.at(-1), /参数不足/);
});

test('ABO-02 channel getEntity failure falls back to participant search', async () => {
  const bobby = user({id: '1002', firstName: 'Bobby', username: 'bobby', participant: adminParticipant('A')});
  const f = fixture({users: [bobby], getEntityFails: ['@bobby'], channelParticipants: {users: [bobby], participants: [{}]}});
  await f.run('.admin_board lock @bobby');
  assert.deepEqual(f.savedLocks(), ['1002']);
});

test('ABO-02 basic-group getEntity failure falls back to participant list', async () => {
  const bobby = user({id: '1002', firstName: 'Bobby', username: 'bobby', participant: adminParticipant('A')});
  const f = fixture({target: basicChat(50, 'Basic'), users: [bobby], getEntityFails: ['@bobby']});
  await f.run('.admin_board lock @bobby');
  assert.deepEqual(f.savedLocks(), ['1002']);
});

test('ABO-02 long numeric IDs survive the channel pagination fallback exactly', async () => {
  const bigId = '1234567890123456789';
  const target = user({id: bigId, firstName: 'Big', participant: adminParticipant('A')});
  const f = fixture({users: [target], getEntityFails: [bigId], channelParticipants: {users: [target], participants: [{}]}});
  await f.run(`.admin_board lock ${bigId}`);
  assert.deepEqual(f.savedLocks(), [bigId], 'exact decimal ID is stored');
});

// ---------------------------------------------------------------------------
// ABO-03: restored output features
// ---------------------------------------------------------------------------
test('ABO-03 ls restores rank, comments and total/Bot/non-Bot counts', async () => {
  const f = fixture({users: [
    user({id: '1', firstName: 'Owner', participant: creatorParticipant()}),
    user({id: '2', firstName: 'Normal', username: 'normal', participant: adminParticipant('A')}),
    user({id: '3', firstName: 'Botty', bot: true, participant: adminParticipant('B')}),
  ]});
  await f.run('.admin_board ls');
  const page = f.edits.at(-1);
  assert.match(page, /<code>A<\/code>/, 'admin rank rendered');
  assert.match(page, /<i>/, 'stable comment rendered');
  assert.match(page, /总 <code>3<\/code>/);
  assert.match(page, /Bot <code>1<\/code>/);
  assert.match(page, /非 Bot <code>2<\/code>/);
});

test('ABO-03 lock reports successful users and cached raw IDs', async () => {
  const alice = user({id: '1001', firstName: 'Alice', username: 'alice', participant: adminParticipant('A')});
  const f = fixture({users: [alice], getEntityFails: ['999'],
    cache: {'77:999': {updatedAt: Date.now(), name: 'CachedName', username: 'cached'}}});
  await f.run('.admin_board lock @alice, 999');
  const page = f.edits.at(-1);
  assert.match(page, /Alice/);
  assert.match(page, /tg:\/\/user\?id=1001/);
  assert.match(page, /CachedName/);
  assert.match(page, /按 ID 直接记录/);
  assert.deepEqual(f.savedLocks().sort(), ['1001', '999']);
});

test('ABO-03 rm reports progress and the demoted admins', async () => {
  const f = fixture({users: [
    user({id: '1', firstName: 'Owner', participant: creatorParticipant()}),
    user({id: '2', firstName: 'Normal', participant: adminParticipant('A')}),
  ], searchCounts: {'1': 0, '2': 7}});
  await f.run('.admin_board rm 1');
  assert.ok(f.edits.some(text => /进度: <code>1\/1<\/code>/.test(text)), 'progress feedback');
  const final = f.edits.at(-1);
  assert.match(final, /已下掉/);
  assert.match(final, /Normal/);
  assert.match(final, /tg:\/\/user\?id=2/);
});

test('ABO-03 clear names the target and states seats are unaffected', async () => {
  const f = fixture({cache: {'77:1': {updatedAt: Date.now(), avgPerDay: 1}}});
  await f.run('.admin_board clear');
  const page = f.edits.at(-1);
  assert.match(page, /目标对话/);
  assert.match(page, /席位锁定数据不受影响/);
  assert.match(page, /清理条目: <code>1<\/code>/);
});

// ---------------------------------------------------------------------------
// ABO-04: validation happens before any target RPC
// ---------------------------------------------------------------------------
test('ABO-04 rm without a count and tail 0 reject before RPC', async () => {
  const f = fixture();
  await f.run('.admin_board rm');
  assert.match(f.edits.at(-1), /必填正整数/);
  await f.run('.admin_board tail 0');
  assert.match(f.edits.at(-1), /正整数/);
  assert.equal(f.calls.length, 0, 'no target or user RPC for invalid usage');
});

test('ABO-04 unknown actions reject before RPC', async () => {
  const f = fixture();
  await f.run('.admin_board bogus');
  assert.match(f.edits.at(-1), /不支持的动作/);
  assert.equal(f.calls.length, 0);
});

// ---------------------------------------------------------------------------
// ABO-05: cancellation stops the chain and real requests serialize long IDs
// ---------------------------------------------------------------------------
test('ABO-05 cancellation during the first demote performs no further RPC', async () => {
  let inputCalls = 0;
  const f = fixture({users: [
    user({id: '1', firstName: 'Owner', participant: creatorParticipant()}),
    user({id: '2', firstName: 'Normal', participant: adminParticipant('A')}),
    user({id: '3', firstName: 'Other', participant: adminParticipant('A')}),
  ], cache: {'77:1': {updatedAt: Date.now(), avgPerDay: 0}, '77:2': {updatedAt: Date.now(), avgPerDay: 7},
    '77:3': {updatedAt: Date.now(), avgPerDay: 6}},
  onGetInputEntity: async () => { inputCalls += 1; if (inputCalls === 1) f.controller.abort(new DOMException('cancelled', 'AbortError')); }});
  await f.run('.admin_board rm 2');
  assert.equal(f.editAdmins().length, 0, 'no demotion RPC after cancellation');
  assert.ok(inputCalls <= 1, 'the second candidate is never resolved');
  assert.equal(f.controller.signal.aborted, true);
});

test('ABO-05 cancellation during the first stats query stops later queries', async () => {
  const f = fixture({users: [
    user({id: '1', firstName: 'Owner', participant: creatorParticipant()}),
    user({id: '2', firstName: 'Normal', participant: adminParticipant('A')}),
  ], onInvoke: async request => {
    if (request instanceof Api.messages.Search) {
      f.controller.abort(new DOMException('cancelled', 'AbortError'));
    }
  }});
  await f.run('.admin_board ls');
  const searches = f.invokes.filter(request => request instanceof Api.messages.Search).length;
  assert.equal(searches, 1, 'only the first stats query runs');
  assert.ok(!f.invokes.some(request => request instanceof Api.channels.EditAdmin || request instanceof Api.messages.EditChatAdmin));
});

test('ABO-05 real requests serialize with exact long IDs', async () => {
  const longChat = '1001234567890123456789';
  const bigUser = '1234567890123456789';
  const f = fixture({
    target: channel('1234567890123456789', 'Big', 'big'),
    users: [user({id: bigUser, firstName: 'Big', participant: adminParticipant('A')})],
    wire: true,
    searchCounts: {[bigUser]: 7},
  });
  await f.run('.admin_board rm 1');
  const edit = f.invokes.find(request => request instanceof Api.channels.EditAdmin);
  assert.ok(edit, 'EditAdmin was built');
  assert.equal(String(edit.userId.userId), bigUser, 'user ID keeps full precision');
  assert.equal(String(edit.channel.channelId), '1234567890123456789', 'channel ID keeps full precision');
  assert.ok(edit.getBytes().length > 0);

  const chat = f.invokes.find(request => request instanceof Api.messages.EditChatAdmin);
  assert.equal(chat, undefined, 'channel target uses EditAdmin, not EditChatAdmin');
  void longChat;
});

// ---------------------------------------------------------------------------
// Pagination: SDK rendering, continuation markers, escaped long input
// ---------------------------------------------------------------------------
const listPages = (f) => [f.edits.at(-1), ...f.replies];
const continuation = /^📋 <b>续 \d+\/\d+<\/b>/;

test('pagination keeps every admin, marks continuation pages and bounds each page', async () => {
  const users = Array.from({length: 80}, (_, index) => user({id: String(index + 1),
    firstName: `Admin${String(index + 1).padStart(2, '0')}`, participant: adminParticipant('A')}));
  const f = fixture({users});
  await f.run('.admin_board ls');
  const pages = listPages(f);
  assert.ok(pages.length >= 2, 'the list paginates');
  assert.ok(f.replies.length >= 1 && f.replies.every(page => continuation.test(page)), 'every reply is a marked continuation');
  const all = pages.join('\n');
  for (let index = 1; index <= 80; index++) {
    assert.ok(all.includes(`Admin${String(index).padStart(2, '0')}`), `Admin${index} survives pagination`);
  }
  for (const page of pages) {
    assert.ok(page && page.length > 0, 'no empty page');
    assert.ok(page.length <= 3500, `page bounded (${page.length})`);
  }
});

test('pagination preserves long escaped text without emitting raw markup', async () => {
  const longName = '<b>&"x'.repeat(400);
  const f = fixture({users: [
    user({id: '1', firstName: 'Owner', participant: creatorParticipant()}),
    user({id: '2', firstName: longName, participant: adminParticipant('A')}),
  ], searchCounts: {'1': 0, '2': 7}});
  await f.run('.admin_board ls');
  const pages = listPages(f);
  assert.ok(pages.length >= 2, 'long escaped input paginates');
  const all = pages.join('\n');
  assert.ok(all.includes('&lt;b&gt;'), 'escaped angle brackets survive');
  assert.ok(all.includes('&amp;'), 'escaped ampersand survives');
  assert.ok(all.includes('&quot;'), 'escaped quote survives');
  assert.ok(!all.includes('<b>&"x'), 'raw markup is not emitted');
  assert.ok(f.replies.every(page => continuation.test(page)), 'continuations are marked');
  for (const page of pages) assert.ok(page.length > 0 && page.length <= 3500);
});

// ---------------------------------------------------------------------------
// Real PluginHost: non-default prefix + alias routing, pagination and unload
// ---------------------------------------------------------------------------
function defer() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }

async function hostFixture(options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(core, 'temp/ab-host-')));
  const target = options.target ?? channel(77, 'Team', 'team');
  const users = options.users ?? [user({id: '1001', firstName: 'Alice', username: 'alice', participant: adminParticipant('A')})];
  const edits = [], replies = [], invokes = [], calls = [];
  const firstEdit = defer();
  let activeSignal;
  const client = {
    async getEntity(value) {
      if (value && typeof value === 'object' && (value === target || value.className === 'Channel' || value.className === 'Chat')) { calls.push({method: 'getEntity', value: '<target>'}); return target; }
      const key = String(value);
      calls.push({method: 'getEntity', value: key});
      if (key === String(target.id)) return target;
      if (key.startsWith('@')) {
        if (target.username && `@${target.username}` === key) return target;
        const found = users.find(candidate => candidate.username && `@${candidate.username}` === key);
        if (found) return found;
        throw new Error('USERNAME_NOT_OCCUPIED');
      }
      return users.find(candidate => String(candidate.id) === key) ?? target;
    },
    async getParticipants(_entity, params = {}) {
      calls.push({method: 'getParticipants'});
      if (params.search) return users.filter(candidate => (candidate.username || '').toLowerCase() === params.search.toLowerCase());
      return users;
    },
    async getInputEntity(value) {
      calls.push({method: 'getInputEntity'});
      if (value && value.className === 'User') return new Api.InputPeerUser({userId: value.id, accessHash: bi(1)});
      if (value && value.className === 'Channel') return new Api.InputPeerChannel({channelId: value.id, accessHash: bi(7)});
      if (value && value.className === 'Chat') return new Api.InputPeerChat({chatId: value.id});
      return value;
    },
    async getMessages(_entity, params = {}) {
      calls.push({method: 'getMessages'});
      return [{date: options.lastDates?.[String(params.fromUser?.id ?? '')] ?? 100}];
    },
    async invoke(request) {
      invokes.push(request);
      calls.push({method: 'invoke', className: request?.className});
      if (options.wire) {
        await request.resolve({getInputEntity: async (value) => {
          if (value && value.className === 'Channel') return new Api.InputPeerChannel({channelId: value.id, accessHash: bi(7)});
          if (value && value.className === 'User') return new Api.InputPeerUser({userId: value.id, accessHash: bi(1)});
          return value;
        }}, utils);
        request.getBytes();
      }
      if (request instanceof Api.messages.Search) return {count: options.searchCounts?.[String(request.fromId?.userId ?? '')] ?? 0};
      if (request instanceof Api.channels.EditAdmin) {
        firstEdit.resolve();
        if (options.blockEditAdmin) {
          await new Promise((_resolve, reject) => activeSignal.addEventListener('abort', () => reject(activeSignal.reason), {once: true}));
        }
        return {};
      }
      return {};
    },
  };
  const host = new PluginHost({storageRoot: root, selfId: '1',
    prefixes: options.prefixes ?? ['.'], aliases: options.aliases ?? {},
    logger: {info() {}, error() {}},
    telegram: {
      edit: async (_message, text, _options, signal) => { signal.throwIfAborted(); edits.push(text); },
      reply: async (_message, text, _options, signal) => { signal.throwIfAborted(); replies.push(text); },
      invoke: async () => ({}),
      getReply: async () => undefined,
      withClient: async (operation, signal) => { activeSignal = signal; return operation(client, signal); },
    }});
  await host.load(create());
  const send = (text) => host.dispatchPrimary({id: 1, chatId: String(target.id), senderId: '1', outgoing: true, text});
  const cleanup = async () => {
    const report = await host.shutdown(2000);
    assert.equal(report.completed, true);
    await fs.rm(root, {recursive: true, force: true});
  };
  const savedLocks = async () => {
    try { return JSON.parse(await fs.readFile(path.join(root, 'admin_board/seat_locks.json'), 'utf8')).lockedSeats; }
    catch { return {}; }
  };
  return {host, send, edits, replies, invokes, calls, target, users, root, firstEdit, savedLocks, cleanup,
    editAdmins: () => invokes.filter(request => request instanceof Api.channels.EditAdmin)};
}

test('real host routes a non-default prefix and alias to lock', async t => {
  const h = await hostFixture({prefixes: ['!'], aliases: {ab: 'admin_board'}});
  t.after(() => h.cleanup());
  assert.equal(await h.send('!ab lock @alice'), true);
  assert.deepEqual((await h.savedLocks())['77'], ['1001']);
});

test('real host paginates an alias list with continuation markers', async t => {
  const users = Array.from({length: 80}, (_, index) => user({id: String(index + 1),
    firstName: `Admin${String(index + 1).padStart(2, '0')}`, participant: adminParticipant('A')}));
  const h = await hostFixture({prefixes: ['!'], aliases: {ab: 'admin_board'}, users});
  t.after(() => h.cleanup());
  assert.equal(await h.send('!ab ls'), true);
  const pages = [h.edits.at(-1), ...h.replies];
  assert.ok(pages.length >= 2, 'the host list paginates');
  assert.ok(h.replies.every(page => continuation.test(page)), 'continuations marked through the host');
  const all = pages.join('\n');
  for (let index = 1; index <= 80; index++) assert.ok(all.includes(`Admin${String(index).padStart(2, '0')}`));
  for (const page of pages) assert.ok(page.length > 0 && page.length <= 3500);
});

test('unloading the plugin cancels an in-flight demotion and completes', async t => {
  const users = [
    user({id: '1', firstName: 'Owner', participant: creatorParticipant()}),
    user({id: '2', firstName: 'Normal', participant: adminParticipant('A')}),
    user({id: '3', firstName: 'Other', participant: adminParticipant('A')}),
  ];
  const h = await hostFixture({users, blockEditAdmin: true, searchCounts: {'1': 0, '2': 7, '3': 6}});
  t.after(() => h.cleanup());
  const running = h.send('.admin_board rm 2');
  await h.firstEdit.promise;
  const report = await h.host.unload('admin_board', 1000);
  assert.equal(report?.completed, true);
  await running;
  assert.equal(h.editAdmins().length, 1, 'no further demotion after unload');
});
