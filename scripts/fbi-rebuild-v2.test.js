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
  await host.load(create());
  t.after(async () => { assert.equal((await host.shutdown(2000)).completed, true); await fs.rm(root, {recursive: true, force: true}); });
  return {root, host, edits, sent,
    read: async (name = 'cache.json') => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')),
    listen: (chat, id, extra = {}) => host.dispatchListeners({id, chatId: peer(chat), senderId: '42', outgoing: false,
      text: `message ${id}`, raw: {date: now, peerId: peer(chat)}, ...extra}),
    run: text => host.dispatchPrimary({id: 999, chatId: peer(900), senderId: '42', outgoing: true, text}),
  };
}

test('fbi rebuild merges live increments over fetched history instead of evicting it', async t => {
  let entered, release;
  const ready = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const cache = {[peer(42)]: {username: 'group42', msgs: Array.from({length: 3000}, (_, index) => cached(3000 - index, now - 10000 - index))}};
  const f = await fixture(t, {cache, client: {
    async getDialogs() { return [{id: peer(42), isGroup: true}]; },
    async *iterMessages() { entered(); await gate; for (let id = 6000; id >= 3001; id--) yield cached(id, now - 1); },
  }});
  const rebuild = f.run('.fbi cache rebuild');
  await ready;
  await f.listen(42, 6001);
  release();
  await rebuild;
  const saved = await f.read();
  const msgs = saved.cache[peer(42)].msgs;
  assert.equal(msgs.length, 3000);
  assert.equal(msgs[0].id, 6001, 'live message must sort first');
  assert.equal(msgs.filter(message => message.id === 6001).length, 1, 'no duplicate live message');
  assert.equal(msgs.filter(message => message.id >= 3001 && message.id <= 6000).length, 2999, 'fetched history must survive');
  assert.equal(msgs.filter(message => message.id <= 3000).length, 0, 'old cache must not be treated as an increment');
  for (let index = 1; index < msgs.length; index++) {
    assert.ok(msgs[index - 1].date > msgs[index].date ||
      (msgs[index - 1].date === msgs[index].date && msgs[index - 1].id > msgs[index].id), 'newest-first order');
  }
  assert.deepEqual(saved.extension, {keep: 'cache'}, 'unknown root fields preserved');
});

test('fbi rebuild lets an edit received during rebuild override the fetched copy', async t => {
  let entered, release;
  const ready = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const cache = {[peer(42)]: {username: 'group42', msgs: [cached(5000, now - 5, {text: 'original-5000'})]}};
  const f = await fixture(t, {cache, client: {
    async getDialogs() { return [{id: peer(42), isGroup: true}]; },
    async *iterMessages() { entered(); await gate; yield cached(5000, now - 1, {text: 'fetched-5000'}); yield cached(4999, now - 1); },
  }});
  const rebuild = f.run('.fbi cache rebuild');
  await ready;
  await f.listen(42, 5000, {edited: true, text: 'edited-5000'});
  release();
  await rebuild;
  const msgs = (await f.read()).cache[peer(42)].msgs;
  assert.equal(msgs.find(message => message.id === 5000).text, 'edited-5000');
  assert.equal(msgs.filter(message => message.id === 5000).length, 1);
});

test('fbi rebuild keeps a touched chat without its stale history and drops untouched chats', async t => {
  let entered, release;
  const ready = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const cache = {
    [peer(42)]: {username: 'group42', msgs: [cached(3000, now - 100)]},
    [peer(43)]: {username: 'group43', msgs: [cached(2000, now - 100)]},
  };
  const f = await fixture(t, {cache, client: {
    async getDialogs() { return [{id: peer(42), isGroup: true}]; },
    async *iterMessages() { entered(); await gate; yield cached(6000, now - 1); },
  }});
  const rebuild = f.run('.fbi cache rebuild');
  await ready;
  await f.listen(43, 7000);
  release();
  await rebuild;
  const saved = (await f.read()).cache;
  assert.deepEqual(saved[peer(42)].msgs.map(message => message.id), [6000]);
  assert.deepEqual(saved[peer(43)].msgs.map(message => message.id), [7000]);
});
