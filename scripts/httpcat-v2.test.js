'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'httpcat', packageRoot: path.resolve(__dirname, '../httpcat'), entry: 'v2.ts'});
const createHttpcat = require(path.join(artifactDir, 'index.cjs')).default;
const envelope = {id: 7, chatId: '123', senderId: '123', outgoing: true, text: '.httpcat 404', raw: {peerId: {}}};

async function fixture(t, fetcher = async () => new Response(new Uint8Array([1, 2, 3]), {status: 200})) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-httpcat-v2-')));
  const edits = [], sent = [], requests = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch: async (url, init) => {
    requests.push({url: new URL(url), init});
    return fetcher(url, init);
  }}, telegram: {
    async edit(message, text, options) { edits.push({message, text, options}); },
    async reply() { assert.fail('unexpected reply'); },
    async invoke() { assert.fail('unexpected invoke'); },
    async getReply() { return undefined; },
    async withClient(operation) { return operation({sendFile: async (...args) => sent.push(args)}, new AbortController().signal); },
  }});
  await host.load(createHttpcat());
  t.after(async () => { assert.equal((await host.shutdown(1000)).completed, true); await fs.rm(root, {recursive: true, force: true}); });
  return {edits, sent, requests, run: text => host.dispatchPrimary({...envelope, text})};
}
test('httpcat validates code and sends bounded image through borrowed client', async t => {
  const f = await fixture(t);
  await f.run('.httpcat 404');
  assert.equal(f.requests[0].url.pathname, '/404.jpg');
  assert.equal(f.requests[0].init.method, 'GET');
  assert.equal(f.sent.length, 1);
  assert.match(f.edits.at(-1).text, /已发送/);
});
test('httpcat rejects invalid status and failed responses without leaking details', async t => {
  const f = await fixture(t, async () => new Response('secret', {status: 404}));
  await f.run('.httpcat 600');
  assert.equal(f.requests.length, 0);
  await f.run('.httpcat 404');
  assert.match(f.edits.at(-1).text, /失败/);
  assert.doesNotMatch(JSON.stringify(f.edits), /secret/);
});
