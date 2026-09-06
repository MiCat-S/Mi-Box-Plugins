'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'fadian', packageRoot: path.resolve(__dirname, '../fadian'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
async function fixture(t, body = ['爱你，<name>']) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-fadian-v2-')));
  const edits = [], requests = [];
  let reply;
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch: async (url) => {requests.push(new URL(url)); return Response.json(body);}}, telegram: {
    async edit(message, text, options) {edits.push({message, text, options});}, async reply() {assert.fail('unexpected reply');},
    async invoke() {assert.fail('unexpected invoke');}, async getReply() {return reply;}, async withClient() {assert.fail('unexpected native call');},
  }});
  await host.load(create());
  t.after(async () => {assert.equal((await host.shutdown(1000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  return {edits, requests, setReply(value) {reply = value;},
    run: text => host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text})};
}
test('fadian generates escaped parameterized text and caches each kind', async t => {
  const f = await fixture(t);
  await f.run('.fadian fd A<&');
  assert.match(f.edits.at(-1).text, /A&lt;&amp;/);
  await f.run('.fadian fd B');
  assert.equal(f.requests.length, 1);
});
test('fadian supports cp and clear', async t => {
  const f = await fixture(t, ['<name1> + <name2>']);
  await f.run('.fadian cp Alice Bob');
  assert.match(f.edits.at(-1).text, /Alice.*Bob/);
  await f.run('.fadian clear');
  assert.match(f.edits.at(-1).text, /缓存已清理/);
});
test('fadian rejects unknown subcommands without network access', async t => {
  const f = await fixture(t);
  await f.run('.fadian nope');
  assert.equal(f.requests.length, 0);
  assert.match(f.edits.at(-1).text, /未知子命令/);
});

test('fadian uses reply sender names instead of the reply body', async t => {
  const f = await fixture(t);
  f.setReply({id: 2, text: 'private message body', raw: {sender: {firstName: 'Alice', lastName: '<Smith>'}}});
  await f.run('.fadian fd');
  assert.equal(f.edits.at(-1).text, '爱你，Alice &lt;Smith&gt;');
  assert.doesNotMatch(f.edits.at(-1).text, /private/);
  f.setReply({id: 2, text: 'private message body'});
  await f.run('.fadian fd');
  assert.equal(f.edits.at(-1).text, '爱你，Ta');
  await f.run('.fadian fd explicit');
  assert.equal(f.edits.at(-1).text, '爱你，explicit');
});

test('fadian instances own independent caches and help stays local', async t => {
  const first = await fixture(t, ['first']);
  const second = await fixture(t, ['second']);
  await first.run('.fadian tg');
  await second.run('.fadian tg');
  assert.equal(first.edits.at(-1).text, 'first');
  assert.equal(second.edits.at(-1).text, 'second');
  assert.equal(second.requests.length, 1);
  await first.run('.fadian clear');
  await second.run('.fadian tg');
  assert.equal(second.requests.length, 1);
  await first.run('.fadian cp help');
  assert.equal(first.requests.length, 1);
});
