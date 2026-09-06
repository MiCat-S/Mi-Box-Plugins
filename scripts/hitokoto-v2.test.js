'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'hitokoto', packageRoot: path.resolve(__dirname, '../hitokoto'), entry: 'v2.ts'});
const createHitokoto = require(path.join(artifactDir, 'index.cjs')).default;
const envelope = {id: 1, chatId: '123', senderId: '123', outgoing: true, text: '.hitokoto'};

async function fixture(t, {body = {hitokoto: '你好 <世界>', from: '来源', from_who: '作者', type: 'a'}, fetch: fetcher} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-hitokoto-v2-')));
  const edits = [], requests = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch: async (input, init) => {
    requests.push({url: new URL(input), init});
    return (fetcher || (async () => Response.json(body)))(input, init);
  }}, telegram: {
    async edit(message, text, options) { edits.push({message, text, options}); },
    async reply() { assert.fail('unexpected reply'); },
    async invoke() { assert.fail('unexpected invoke'); },
    async getReply() { return undefined; },
    async withClient() { assert.fail('unexpected native call'); },
  }});
  await host.load(createHitokoto());
  t.after(async () => { assert.equal((await host.shutdown(1000)).completed, true); await fs.rm(root, {recursive: true, force: true}); });
  return {edits, requests, shutdown: () => host.shutdown(1000), run: text => host.dispatchPrimary({...envelope, text})};
}

test('hitokoto help is local and exposes no network request', async t => {
  const f = await fixture(t);
  await f.run('.hitokoto help');
  assert.match(f.edits[0].text, /一言/);
  assert.equal(f.requests.length, 0);
});

test('hitokoto queries selected types and escapes returned fields', async t => {
  const f = await fixture(t);
  await f.run('.hitokoto a c');
  assert.deepEqual(f.requests[0].url.searchParams.getAll('c'), ['a', 'c']);
  assert.equal(f.requests[0].init.method, 'GET');
  assert.match(f.edits.at(-1).text, /你好 &lt;世界&gt;/);
  assert.match(f.edits.at(-1).text, /《来源》（动画） - 作者/);
  assert.equal(f.edits.at(-1).options.parseMode, 'html');
});

test('hitokoto rejects invalid type and malformed API data without leaking details', async t => {
  const invalid = await fixture(t);
  await invalid.run('.hitokoto z');
  assert.equal(invalid.requests.length, 0);
  assert.match(invalid.edits.at(-1).text, /类型参数无效/);
  const malformed = await fixture(t, {body: {hitokoto: {secret: 'token'}}});
  await malformed.run('.hitokoto a');
  assert.match(malformed.edits.at(-1).text, /获取一言失败/);
  assert.doesNotMatch(JSON.stringify(malformed.edits), /token/);
});

test('hitokoto retries transient failures and succeeds on the third attempt', async t => {
  let requests = 0;
  const f = await fixture(t, {fetch: async () => {
    requests++;
    return requests < 3 ? new Response('temporary', {status: 503}) : Response.json({hitokoto: '成功'});
  }});
  await f.run('.hitokoto a c');
  assert.equal(requests, 3);
  assert.deepEqual(f.requests[0].url.searchParams.getAll('c'), ['a', 'c']);
  assert.match(f.edits.at(-1).text, /成功/);
});

test('hitokoto without arguments requests an unfiltered random quote', async t => {
  const f = await fixture(t);
  await f.run('.hitokoto');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url.searchParams.has('c'), false);
  assert.match(f.edits.at(-1).text, /你好 &lt;世界&gt;/);
});

test('hitokoto unload cancels retry delay and suppresses late output', async t => {
  let started;
  const first = new Promise(resolve => {started = resolve;});
  const f = await fixture(t, {fetch: async () => {
    started();
    throw new Error('temporary network failure');
  }});
  const pending = f.run('.hitokoto');
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.shutdown()).completed, true);
  await pending;
  assert.equal(f.requests.length, 1);
  assert.equal(f.edits.length, 1);
});
