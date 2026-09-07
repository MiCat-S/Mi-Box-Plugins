'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

function load(id) {
  const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, `../${id}`), entry: 'v2.ts'});
  return require(path.join(artifactDir, 'index.cjs')).default;
}

async function fixture(t, id, client) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `mibot-${id}-v2-`)));
  const edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(message, text, options) { edits.push({message, text, options}); },
    async reply() { assert.fail('unexpected reply'); },
    async invoke(request) { return client.invoke(request); },
    async getReply() { return undefined; },
    async withClient(operation, signal) { return operation(client, signal); },
  }});
  await host.load(load(id)());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fsp.rm(root, {recursive: true, force: true});
  });
  return {edits, run: (text, message = {}) => host.dispatchPrimary({
    id: 30, chatId: '100', senderId: '100', outgoing: true, text, ...message,
  })};
}

test('crazy4 V2 data is an exact mechanical extraction of the legacy corpus', () => {
  const legacy = fs.readFileSync(path.resolve(__dirname, '../crazy4/crazy4.ts'), 'utf8');
  const start = legacy.indexOf('const crazy4_data = ');
  const end = legacy.indexOf('\n];', start) + 3;
  const expected = legacy.slice(start + 'const crazy4_data = '.length, end).trim();
  const migrated = fs.readFileSync(path.resolve(__dirname, '../crazy4/v2/data.ts'), 'utf8')
    .replace(/^export const crazy4Data: readonly string\[\] = /, '').replace(/;\s*$/, '').trim();
  assert.equal(migrated, expected.replace(/;$/, ''));
});

test('crazy4 sends one escaped corpus entry and preserves reply context', async t => {
  const sent = [];
  let deleted = 0;
  const f = await fixture(t, 'crazy4', {async sendMessage(peer, value) { sent.push({peer, value}); }});
  const previous = Math.random;
  Math.random = () => 0;
  t.after(() => { Math.random = previous; });
  await f.run('.crazy4', {replyToId: 12, raw: {peerId: {}, async delete() { deleted++; }}});
  assert.equal(sent.length, 1);
  assert.match(sent[0].value.message, /秦始皇/);
  assert.equal(sent[0].value.replyTo, 12);
  assert.equal(deleted, 1);
});

test('biko resolves endpoints, filters one user and sends chronological digest', async t => {
  const source = new Api.Channel({id: 1, accessHash: 2, title: 'Source <Chat>', username: 'source', photo: new Api.ChatPhotoEmpty(), date: 0});
  const target = new Api.Channel({id: 3, accessHash: 4, title: 'Target', username: 'target', photo: new Api.ChatPhotoEmpty(), date: 0});
  const user = new Api.User({id: 5, firstName: 'Alice'});
  const sent = [];
  const client = {
    async getEntity(value) {
      if (value === '@source') return source;
      if (value === '@target') return target;
      return user;
    },
    async *iterMessages() {
      yield new Api.Message({id: 11, peerId: new Api.PeerChannel({channelId: 1}), fromId: new Api.PeerUser({userId: 5}), date: 1788701000, message: 'new <text>'});
      yield new Api.Message({id: 10, peerId: new Api.PeerChannel({channelId: 1}), fromId: new Api.PeerUser({userId: 5}), date: 1788700000, message: 'old text'});
    },
    async sendMessage(peer, value) { sent.push({peer, value}); },
  };
  const f = await fixture(t, 'biko', client);
  await f.run('.biko @source @alice 2 @target');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].peer, target);
  assert.match(sent[0].value.message, /Source &lt;Chat&gt;/);
  assert.match(sent[0].value.message, /old text[\s\S]*new &lt;text&gt;/);
  assert.match(f.edits.at(-1).text, /消息 2 条 · 分片 1/);
});
