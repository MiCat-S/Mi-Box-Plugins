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
const group = {className: 'Channel', id: 10, username: 'publicgroup', title: 'Public group', megagroup: true};
const user = {className: 'User', id: 42, username: 'fixtureuser', firstName: 'Fixture'};

async function fixture(t, {cache = {}, entity = group} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-fbi-scope-')));
  await fs.mkdir(path.join(root, 'fbi'));
  await fs.writeFile(path.join(root, 'fbi/cache.json'), JSON.stringify({schemaVersion: 1, importedLegacy: true, cache}));
  const edits = [], sent = [];
  const client = {async getEntity(value) {return ['42', 'fixtureuser'].includes(String(value)) ? user : entity;},
    async sendMessage(peer, value) {sent.push({peer, value});}};
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(_message, text) {edits.push(text);}, async reply() {}, async invoke() {}, async getReply() {},
    async withClient(operation, signal) {return operation(client, signal);},
  }});
  await host.load(create());
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  const read = async (name = 'cache.json') => JSON.parse(await fs.readFile(path.join(root, 'fbi', name), 'utf8'));
  const run = text => host.dispatchPrimary({id: 1, chatId: '-100900', senderId: '1', outgoing: true, text});
  const listen = (chatId, text, id = 2) => host.dispatchListeners({id, chatId, senderId: '42', outgoing: false, text,
    raw: {date: now, peerId: chatId, isPrivate: chatId === '42'}});
  return {host, read, run, listen, edits, sent};
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
