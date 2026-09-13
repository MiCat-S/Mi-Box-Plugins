'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {resolveId} = require(path.join(core, 'node_modules/teleproto/Utils.js'));
const {artifactDir} = buildPlugin({id: 'fbi', packageRoot: path.resolve(__dirname, '../fbi'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const now = Math.floor(Date.now() / 1000);
const group = {className: 'Channel', id: 10, username: 'publicgroup', title: 'Public group', megagroup: true};
const user = {className: 'User', id: 42, username: 'fixtureuser', firstName: 'Fixture'};

async function fixture(t, {cache = {}, surveillance, entity = group, editHook} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-fbi-scope-')));
  await fs.mkdir(path.join(root, 'fbi'));
  await fs.writeFile(path.join(root, 'fbi/cache.json'), JSON.stringify({schemaVersion: 1, importedLegacy: true, cache}));
  if (surveillance) await fs.writeFile(path.join(root, 'fbi/db.json'), JSON.stringify({schemaVersion: 1, importedLegacy: true, cacheLimit: 300, surveillance}));
  const edits = [], editMessages = [], sent = [];
  const client = {async getEntity(value) {return ['42', 'fixtureuser'].includes(String(value)) ? user : entity;},
    async sendMessage(peer, value) {sent.push({peer, value});}};
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(message, text) {edits.push(text); editMessages.push(message); await editHook?.(message, text);}, async reply() {}, async invoke() {}, async getReply() {},
    async withClient(operation, signal) {return operation(client, signal);},
  }});
  await host.load(create());
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  const read = async (name = 'cache.json') => JSON.parse(await fs.readFile(path.join(root, 'fbi', name), 'utf8'));
  const run = text => host.dispatchPrimary({id: 1, chatId: '-100900', senderId: '1', outgoing: true, text});
  const listen = (chatId, text, id = 2) => host.dispatchListeners({id, chatId, senderId: '42', outgoing: false, text,
    raw: {date: now, peerId: chatId, isPrivate: chatId === '42'}});
  return {host, read, run, listen, edits, editMessages, sent};
}

test('fbi keeps a watch pending when the target sends a private message', async t => {
  const f = await fixture(t);
  await f.run('.fbi sur 42');
  await f.listen('42', 'private fixture text');
  assert.equal(Object.hasOwn((await f.read()).cache, '42'), false);
  assert.deepEqual(f.sent, []);
  assert.ok((await f.read('db.json')).surveillance['42']);
  await f.listen('-10010', 'public fixture text', 3);
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(item => item.value.message.includes('public fixture text')));
});

test('fbi restores group cache while excluding persisted private dialogs from query results', async t => {
  const message = text => ({id: 2, senderId: '42', date: now, text});
  const f = await fixture(t, {cache: {
    '42': {username: 'fixtureuser', msgs: [message('private fixture text')]},
    '-10010': {username: 'publicgroup', msgs: [message('public fixture text')]},
  }});
  await f.run('.fbi det 42');
  assert.match(f.edits.at(-1), /public fixture text/);
  assert.doesNotMatch(f.edits.at(-1), /private fixture text/);
  assert.deepEqual(Object.keys((await f.read()).cache), ['-10010']);
});

test('fbi obs resolves an uncached group link to the marked peer ID and completes once', async t => {
  const f = await fixture(t);
  await f.run('.fbi obs https://t.me/publicgroup 42');
  assert.equal((await f.read('db.json')).surveillance['42'].scopePeer, '-10010');
  await f.listen('-10011', 'different group');
  assert.equal(f.sent.length, 0);
  await f.listen('-10010', 'selected group', 3);
  assert.equal(f.sent.length, 2);
  await f.listen('-10010', 'another message', 4);
  assert.equal(f.sent.length, 2);
});

test('fbi rejects a user profile link as an observation group', async t => {
  const f = await fixture(t);
  await f.run('.fbi obs https://t.me/fixtureuser 42');
  assert.equal((await f.read('db.json')).surveillance['42'], undefined);
  assert.match(f.edits.at(-1), /公开群|群组/);
});

test('fbi consumes one persisted watch exactly once across concurrent chat lanes', async t => {
  const message = text => ({id: 1, senderId: '7', date: now, text});
  const f = await fixture(t, {cache: {
    '-10010': {username: 'group10', msgs: [message('old 10')]},
    '-10011': {username: 'group11', msgs: [message('old 11')]},
  }});
  await f.run('.fbi sur 42');
  await Promise.all([
    f.listen('-10010', 'first concurrent hit', 10),
    f.listen('-10011', 'second concurrent hit', 11),
  ]);
  assert.equal(f.sent.length, 2, 'one winning hit sends to the origin and Saved Messages once');
  assert.deepEqual((await f.read('db.json')).surveillance, {});
  assert.equal(f.sent.filter(item => item.peer === 'me').length, 1);
  const origin = f.sent.find(item => item.peer !== 'me').peer;
  const [id, peerClass] = resolveId(origin);
  assert.equal(id.toString(), '900');
  assert.equal(peerClass.className, 'PeerChannel');
});

test('fbi notification preserves a private trigger peer as a Teleproto user ID', async t => {
  const watch = {targetId: '42', targetName: 'Fixture', triggerPeer: '77', triggerMsgId: 5};
  const f = await fixture(t, {cache: {'-10010': {username: 'publicgroup', msgs: []}}, surveillance: {'42': watch}});
  await f.listen('-10010', 'private-origin watch hit', 12);
  const origin = f.sent.find(item => item.peer !== 'me').peer;
  const [id, peerClass] = resolveId(origin);
  assert.equal(id.toString(), '77');
  assert.equal(peerClass.className, 'PeerUser');
});

test('fbi help and unknown subcommands use bounded complete SDK delivery', async t => {
  const f = await fixture(t);
  await f.run('.fbi help');
  await f.run('.fbi unknown');
  assert.ok(f.edits.every(text => text.length <= 3500));
  for (const token of ['det', 'sur', 'obs', 'loc', 'ssv', 'cache rebuild']) {
    assert.match(f.edits.at(-1), new RegExp(token));
  }
});

test('fbi ssv reports an empty set and closes persisted trigger receipts before clearing', async t => {
  const f = await fixture(t);
  await f.run('.fbi ssv');
  assert.match(f.edits.at(-1), /没有活跃/);
  await f.run('.fbi sur 42');
  await f.run('.fbi ssv');
  assert.ok(f.editMessages.some(message => message.id === 1 && message.chatId === '-100900'));
  assert.deepEqual((await f.read('db.json')).surveillance, {});
});

test('fbi ssv claims watches before awaiting trigger edits', async t => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {
    cache: {'-10010': {username: 'publicgroup', msgs: []}},
    async editHook(message) { if (message.id === 1 && message.text === '') { entered(); await gate; } },
  });
  await f.run('.fbi sur 42');
  const stopping = f.run('.fbi ssv');
  await ready;
  await f.listen('-10010', 'message during stop', 22);
  assert.equal(f.sent.length, 0, 'a claimed watch cannot also emit a found notification');
  assert.deepEqual((await f.read('db.json')).surveillance, {});
  release();
  await stopping;
  assert.equal(f.edits.filter(text => /没有发现/.test(text)).length, 1);
});
