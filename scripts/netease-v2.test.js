'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const utils = require(path.join(core, 'node_modules/teleproto/Utils.js'));
const {returnBigInt} = require(path.join(core, 'node_modules/teleproto/Helpers.js'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'netease', packageRoot: path.resolve(__dirname, '../netease'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t, {client: patch = {}, deleteCommand, httpFetch} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-netease-v2-')));
  const edits = [], replies = [], sent = [], files = [], invokes = [], logs = [];
  const media = {kind: 'audio'};
  let messageReads = 0;
  const client = {
    async invoke(request) {invokes.push(request); return {};},
    async getInputEntity() {return new Api.InputPeerUser({userId: returnBigInt(163), accessHash: returnBigInt(1)});},
    _getInputNotify(peer) {return peer instanceof Api.InputNotifyPeer ? peer : new Api.InputNotifyPeer({peer});},
    async sendMessage(peer, value) {sent.push({peer, value}); return {id: sent.length};},
    async getMessages() {return messageReads++ ? [{id: 9, out: false, date: Math.floor(Date.now() / 1000), media, message: 'Song via @Music163bot'}] : [];},
    async sendFile(peer, value) {files.push({peer, value});},
    ...patch,
  };
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error(event, fields) {logs.push({event, fields});}},
    http: {fetch: httpFetch || (async () => assert.fail('netease has no HTTP path'))}, telegram: {
      async edit(message, text, options) {edits.push({message, text, options});}, async reply(message, text, options) {replies.push({message, text, options});},
      async invoke(request) {return client.invoke(request);}, async getReply() {},
      async withClient(operation, signal) {return operation(client, signal);},
    }});
  await host.load(create());
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  const run = (text, extra = {}) => host.dispatchPrimary({id: 20, chatId: '100', senderId: '100', outgoing: true, text,
    raw: {peerId: {className: 'PeerUser'}, async delete(options) {await deleteCommand?.(options);}, ...extra.raw}, ...extra});
  const runAt = (chatId, text) => host.dispatchPrimary({id: 20, chatId, senderId: chatId, outgoing: true, text,
    raw: {peerId: {chatId}, async delete() {}}});
  return {root, host, edits, replies, sent, files, invokes, logs, media, run, runAt};
}

test('netease help is complete and performs no native or HTTP interaction', async t => {
  const f = await fixture(t);
  await f.run('.netease');
  assert.match(f.edits.at(-1).text, /关键词/);
  assert.match(f.edits.at(-1).text, /链接/);
  assert.match(f.edits.at(-1).text, /ID/);
  assert.deepEqual({sent: f.sent.length, invokes: f.invokes.length}, {sent: 0, invokes: 0});
});

test('netease preserves exact numeric IDs and configures, reads and sends through Music163bot', async t => {
  let deleted = 0;
  const f = await fixture(t, {deleteCommand: async options => {assert.equal(options.revoke, true); deleted++;}});
  const id = '9007199254740993123456789';
  await f.run(`.netease ${id}`, {replyToId: 7});
  assert.ok(f.invokes.some(request => request instanceof Api.contacts.Unblock));
  assert.ok(f.invokes.some(request => request instanceof Api.account.UpdateNotifySettings));
  assert.ok(f.invokes.some(request => request instanceof Api.messages.StartBot));
  assert.ok(f.invokes.some(request => request instanceof Api.messages.ReadHistory));
  assert.ok(f.sent.some(item => item.peer === 'Music163bot' && item.value.message === `/music ${id}`));
  assert.equal(f.files[0].value.file, f.media);
  assert.equal(f.files[0].value.caption, 'Song');
  assert.equal(f.files[0].value.replyTo, 7);
  assert.equal(deleted, 1);
});

test('netease notification configuration resolves and serializes with real TL types', async t => {
  let serialized = 0;
  const f = await fixture(t, {client: {async invoke(request) {
    if (request instanceof Api.account.UpdateNotifySettings) {
      await request.resolve(this, utils);
      assert.ok(request.getBytes().length > 0);
      assert.ok(request.peer instanceof Api.InputNotifyPeer);
      serialized++;
    }
    return {};
  }}});
  await f.run('.netease 123');
  assert.equal(serialized, 1);
});

test('netease only extracts song IDs from NetEase links and keeps search text intact', async t => {
  const evil = await fixture(t);
  await evil.run('.netease https://example.com/song?id=123');
  assert.ok(evil.sent.some(item => item.value.message === '/search https://example.com/song?id=123'));
  const netease = await fixture(t);
  await netease.run('.netease https://music.163.com/#/song?id=456');
  assert.ok(netease.sent.some(item => item.value.message === '/music 456'));
  const subdomain = await fixture(t);
  await subdomain.run('.netease https://y.music.163.com/song/789');
  assert.ok(subdomain.sent.some(item => item.value.message === '/music 789'));
});

test('netease ignores same-second media at or below the pre-request message ID watermark', async t => {
  let reads = 0;
  const staleMedia = {kind: 'stale'}, freshMedia = {kind: 'fresh'};
  const stale = {id: 50, out: false, date: 123, media: staleMedia, message: 'Old'};
  const fresh = {id: 51, out: false, date: 123, media: freshMedia, message: 'Fresh'};
  const f = await fixture(t, {client: {async getMessages() {return reads++ < 2 ? [stale] : [fresh, stale];}}});
  await f.run('.netease query');
  assert.equal(f.files[0].value.file, freshMedia);
  assert.equal(f.files[0].value.caption, 'Fresh');
});

test('netease serializes concurrent chats so each query receives its own bot media', async t => {
  let nextId = 100, active;
  const history = [];
  const f = await fixture(t, {client: {
    async sendMessage(peer, value) {if (/^\/(?:search|music) /.test(value.message)) active = value.message.split(' ').slice(1).join(' '); return {id: ++nextId, out: true};},
    async getMessages() {
      if (active) {history.unshift({id: ++nextId, out: false, date: 1, media: {query: active}, message: `Song ${active}`}); active = undefined;}
      return history.slice();
    },
  }});
  await Promise.all([f.runAt('101', '.netease alpha'), f.runAt('202', '.netease beta')]);
  assert.deepEqual(f.files.map(item => item.value.file.query), ['alpha', 'beta']);
  assert.deepEqual(f.files.map(item => item.value.caption), ['Song alpha', 'Song beta']);
});

test('netease queued cancellation cannot overtake an in-flight predecessor', async t => {
  let entered, release;
  const ready = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const commands = [];
  const f = await fixture(t, {client: {
    async getMessages() {return [];},
    async sendMessage(_peer, value) {if (/^\/search /.test(value.message)) {commands.push(value.message); if (commands.length === 1) {entered(); await gate;}} return {id: commands.length + 1};},
  }});
  const first = f.runAt('101', '.netease first');
  await ready;
  const second = f.runAt('202', '.netease second');
  await new Promise(resolve => setImmediate(resolve));
  const unloading = f.host.unload('netease', 1000);
  await assert.rejects(second, error => error?.name === 'AbortError' || error?.name === 'TelegramAbortError');
  assert.deepEqual(commands, ['/search first']);
  release();
  assert.equal((await unloading).completed, true);
  await assert.rejects(first, error => error?.name === 'AbortError' || error?.name === 'TelegramAbortError');
  assert.deepEqual(commands, ['/search first']);
});

test('netease follows start and command fallbacks and clicks a search result', async t => {
  let reads = 0, clicks = 0, commandFailures = 0;
  const button = {id: 8, out: false, date: Math.floor(Date.now() / 1000), buttonCount: 1, async click() {clicks++;}};
  const media = {kind: 'selected-audio'};
  const f = await fixture(t, {client: {
    async invoke(request) {if (request instanceof Api.messages.StartBot) throw new Error('not started'); return {};},
    async sendMessage(peer, value) {
      if (value.message === '/search query' && commandFailures++ === 0) throw new Error('slash rejected');
      f.sent.push({peer, value}); return {id: 1};
    },
    async getMessages() {if (++reads === 1) return []; return clicks ? [{id: 9, out: false, date: button.date, media, message: ''}] : [button];},
  }});
  await f.run('.netease query');
  assert.ok(f.sent.some(item => item.value.message === '/start'));
  assert.ok(f.sent.some(item => item.value.message === 'query'));
  assert.equal(clicks, 1);
  assert.equal(f.files[0].value.file, media);
  assert.equal(f.files[0].value.caption, '🎵 query');
});

test('netease cancellation after an in-flight native send starts no polling, upload or cleanup', async t => {
  let entered, release, polls = 0, uploads = 0, deletes = 0;
  const ready = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, {deleteCommand: async () => {deletes++;}, client: {
    async sendMessage(peer, value) {if (value.message === '/music 123') {entered(); await gate;} return {id: 1};},
    async getMessages() {polls++; return [];}, async sendFile() {uploads++;},
  }});
  const pending = f.run('.netease 123');
  await ready;
  const unloading = f.host.unload('netease', 1000);
  release();
  assert.equal((await unloading).completed, true);
  await assert.rejects(pending, error => error?.name === 'AbortError' || error?.name === 'TelegramAbortError');
  assert.deepEqual({polls, uploads, deletes}, {polls: 1, uploads: 0, deletes: 0});
});

test('netease keeps a successful upload successful when command cleanup fails', async t => {
  const f = await fixture(t, {deleteCommand: async () => {throw Object.assign(new Error('SECRET_DELETE'), {name: 'SECRET_NAME'});}});
  await f.run('.netease 123');
  assert.equal(f.files.length, 1);
  assert.equal(f.edits.some(item => /获取失败/.test(item.text)), false);
  assert.deepEqual(f.logs.at(-1), {event: 'netease_cleanup_failed', fields: {kind: 'internal'}});
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET_/);
});
