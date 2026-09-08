'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'fbi', packageRoot: path.resolve(__dirname, '../fbi'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const now = Math.floor(Date.now() / 1000);
const peer = id => `-100${id}`;
const cached = (id, date = now, extra = {}) => ({id, senderId: '42', date, text: `message ${id}`, ...extra});
const group = (id, date = now) => ({username: `group${id}`, title: `Group ${id}`, msgs: [cached(id, date)]});

async function fixture(t, {cache = {}, cacheLimit = 10, surveillance = {}, client: clientPatch = {}} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-fbi-cache-')));
  const dir = path.join(root, 'fbi');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'db.json'), JSON.stringify({schemaVersion: 1, importedLegacy: true,
    cacheLimit, surveillance, extension: {keep: 'config'}}));
  await fs.writeFile(path.join(dir, 'cache.json'), JSON.stringify({schemaVersion: 1, importedLegacy: true,
    cache, extension: {keep: 'cache'}}));
  const edits = [], sent = [];
  const client = {
    async getEntity(value) { return {id: value, username: `group${String(value).replace(/\D/g, '')}`, title: 'Public group'}; },
    async sendMessage(target, message) { sent.push({target, message}); },
    ...clientPatch,
  };
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}},
    http: {fetch: async () => new Response('', {status: 500})}, telegram: {
      async edit(message, text) { edits.push({message, text}); }, async reply() {}, async invoke() {}, async getReply() {},
      async withClient(operation, signal) { return operation(client, signal); },
    }});
  const definition = create();
  await host.load(definition);
  t.after(async () => { assert.equal((await host.shutdown(2000)).completed, true); await fs.rm(root, {recursive: true, force: true}); });
  return {root, host, definition, edits, sent,
    read: async (name = 'cache.json') => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')),
    listen: (chat, id, extra = {}) => host.dispatchListeners({id, chatId: peer(chat), senderId: '42', outgoing: false,
      text: `message ${id}`, raw: {date: now, peerId: peer(chat)}, ...extra}),
    run: text => host.dispatchPrimary({id: 999, chatId: peer(900), senderId: '42', outgoing: true, text}),
  };
}

test('new public groups obey the configured limit and retain the most recently active groups', async t => {
  const f = await fixture(t);
  for (let id = 1; id <= 10; id++) await f.listen(id, id);
  await f.listen(1, 101);
  await f.listen(11, 11);
  const saved = await f.read();
  assert.equal(Object.keys(saved.cache).length, 10);
  assert.ok(saved.cache[peer(1)]);
  assert.equal(saved.cache[peer(2)], undefined);
  assert.ok(saved.cache[peer(11)]);
  assert.deepEqual(saved.extension, {keep: 'cache'});
  assert.equal((await f.host.unload('fbi', 2000)).completed, true);
  await f.host.load(create());
  await f.run('.fbi cache');
  assert.match(f.edits.at(-1).text, /缓存群组：10/);
});

test('setup prunes expired and duplicate messages, caps history and preserves active groups and unknown fields', async t => {
  const cache = {};
  for (let id = 13; id >= 1; id--) cache[peer(id)] = group(id, now - id);
  cache[peer(1)].custom = {keep: 'chat'};
  cache[peer(1)].msgs = [cached(9999, now, {custom: 'message'}), cached(9999, now - 1),
    ...Array.from({length: 3001}, (_, i) => cached(i, now - i - 10)), cached(9000, now - 31 * 86400)];
  const watch = {targetId: '77', targetName: 'Target', triggerPeer: peer(900), triggerMsgId: 999};
  const f = await fixture(t, {cache, surveillance: {'77': watch}});
  const saved = await f.read();
  assert.equal(Object.keys(saved.cache).length, 10);
  assert.ok(saved.cache[peer(1)]);
  assert.equal(saved.cache[peer(13)], undefined);
  assert.equal(saved.cache[peer(1)].msgs.length, 3000);
  assert.equal(new Set(saved.cache[peer(1)].msgs.map(m => m.id)).size, 3000);
  assert.ok(saved.cache[peer(1)].msgs.every(m => m.date > now - 30 * 86400));
  assert.deepEqual(saved.cache[peer(1)].custom, {keep: 'chat'});
  assert.equal(saved.cache[peer(1)].msgs[0].custom, 'message');
  assert.deepEqual(saved.extension, {keep: 'cache'});
  assert.deepEqual((await f.read('db.json')).surveillance, {'77': watch});
  await f.listen(20, 123, {senderId: '77'});
  assert.equal(f.sent.length, 2);
  assert.deepEqual((await f.read('db.json')).surveillance, {});
  assert.deepEqual((await f.read('db.json')).extension, {keep: 'config'});
});

test('commands and settings reduce the existing cache immediately while preserving watch configuration', async t => {
  const cache = Object.fromEntries(Array.from({length: 15}, (_, i) => [peer(i + 1), group(i + 1, now - i)]));
  const surveillance = {'77': {targetId: '77', targetName: 'Target', triggerPeer: peer(900), triggerMsgId: 123}};
  const f = await fixture(t, {cache, cacheLimit: 15, surveillance});
  await f.run('.fbi cache limit 12');
  assert.equal(Object.keys((await f.read()).cache).length, 12);
  await f.host.patchSettings('fbi', {cacheLimit: 10});
  const saved = await f.read();
  assert.equal(Object.keys(saved.cache).length, 10);
  assert.ok(saved.cache[peer(1)]);
  assert.equal(saved.cache[peer(11)], undefined);
  assert.equal((await f.read('db.json')).cacheLimit, 10);
  assert.deepEqual((await f.read('db.json')).surveillance, surveillance);
  await f.run('.fbi cache limit 9');
  assert.match(f.edits.at(-1).text, /缓存上限须为 10 至 1000/);
  assert.equal((await f.read('db.json')).cacheLimit, 10);
});

test('edited messages replace an existing id and remain durable on immediate reload', async t => {
  const f = await fixture(t, {cache: {[peer(1)]: {...group(1), custom: 'chat'}}});
  await f.listen(1, 2);
  await f.listen(1, 1, {edited: true, text: 'edited content'});
  await f.listen(1, 1, {edited: true, text: 'edited again'});
  assert.equal((await f.host.unload('fbi', 2000)).completed, true);
  const saved = await f.read();
  assert.equal(saved.cache[peer(1)].msgs.length, 2);
  assert.equal(saved.cache[peer(1)].msgs.find(m => m.id === 1).text, 'edited again');
  assert.equal(saved.cache[peer(1)].custom, 'chat');
  await f.host.load(create());
  await f.run('.fbi loc 42');
  assert.match(f.edits.at(-1).text, /（2 条）/);
});

test('a burst across public groups settles durable bounded writes before immediate reload', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({length: 24}, (_, i) => f.listen(i + 1, i + 1)));
  assert.equal((await f.host.unload('fbi', 2000)).completed, true);
  const saved = await f.read();
  assert.equal(Object.keys(saved.cache).length, 10);
  assert.equal(Object.values(saved.cache).reduce((total, chat) => total + chat.msgs.length, 0), 10);
  await f.host.load(create());
  await f.run('.fbi cache');
  assert.match(f.edits.at(-1).text, /缓存群组：10/);
});

test('rebuild retains concurrent messages and uses the latest configured group limit', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, {cacheLimit: 12, cache: {[peer(1)]: group(1, now - 5)}, client: {
    async getDialogs() { started(); await gate; return Array.from({length: 11}, (_, i) => ({id: peer(i + 1), isGroup: true})); },
    async *iterMessages(chat) {
      const id = Number(String(chat).slice(4));
      yield cached(id, now - id);
      yield cached(9000, now - 31 * 86400);
    },
  }});
  const running = f.run('.fbi cache rebuild');
  await ready;
  await f.listen(1, 1, {edited: true, text: 'edited during rebuild'});
  await f.listen(50, 50, {text: 'received during rebuild'});
  await f.host.patchSettings('fbi', {cacheLimit: 10});
  release();
  await running;
  const saved = await f.read();
  assert.equal(Object.keys(saved.cache).length, 10);
  assert.equal(saved.cache[peer(1)].msgs.length, 1);
  assert.equal(saved.cache[peer(1)].msgs[0].text, 'edited during rebuild');
  assert.equal(saved.cache[peer(50)].msgs[0].text, 'received during rebuild');
  assert.ok(Object.values(saved.cache).every(chat => chat.msgs.every(m => m.date > now - 30 * 86400)));
});

test('the same plugin definition can unload and set up again with its durable configuration', async t => {
  const f = await fixture(t, {cacheLimit: 12});
  for (let id = 1; id <= 12; id++) await f.listen(id, id);
  await f.host.patchSettings('fbi', {cacheLimit: 10});
  assert.equal((await f.host.unload('fbi', 2000)).completed, true);
  await f.host.load(f.definition);
  await f.listen(20, 20);
  const saved = await f.read();
  assert.equal(Object.keys(saved.cache).length, 10);
  assert.equal(saved.cache[peer(3)], undefined);
  assert.ok(saved.cache[peer(20)]);
});

test('a listener resolving a new group after rebuild keeps the rebuilt history', async t => {
  let release, started, entityCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, {client: {
    async getEntity() {
      if (++entityCalls === 1) { started(); await gate; }
      return {username: 'publicgroup', title: 'Public group'};
    },
    async getDialogs() { return [{id: peer(1), isGroup: true}]; },
    async *iterMessages() { yield cached(1, now - 1); },
  }});
  const running = f.listen(1, 100);
  await ready;
  await f.run('.fbi cache rebuild');
  release();
  await running;
  assert.deepEqual((await f.read()).cache[peer(1)].msgs.map(m => m.id), [100, 1]);
});

test('unload drains a cache write already submitted for atomic commit', async t => {
  const f = await fixture(t);
  const rename = fs.rename;
  let release, submitted;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { submitted = resolve; });
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === path.join(f.root, 'fbi', 'cache.json')) { submitted(); await gate; }
    return rename(source, destination);
  });
  const running = f.listen(1, 1);
  await ready;
  const report = await f.host.unload('fbi', 10);
  assert.equal(report.completed, false);
  release();
  await running;
  assert.equal((await f.host.unload('fbi', 2000)).completed, true);
  assert.equal((await f.read()).cache[peer(1)].msgs[0].id, 1);
  await f.host.load(create());
  await f.run('.fbi loc 42');
  assert.match(f.edits.at(-1).text, /（1 条）/);
});
