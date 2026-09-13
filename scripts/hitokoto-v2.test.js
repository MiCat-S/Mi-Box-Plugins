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

async function fixture(t, {body = {hitokoto: '你好 <世界>', from: '来源', from_who: '作者', type: 'a'}, fetch: fetcher, onEdit, onReply} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-hitokoto-v2-')));
  const edits = [], replies = [], requests = [], errors = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error(...args) { errors.push(args); }}, http: {fetch: async (input, init) => {
    requests.push({url: new URL(input), init});
    return (fetcher || (async () => Response.json(body)))(input, init);
  }}, telegram: {
    async edit(message, text, options) { await onEdit?.(message, text, options); edits.push({message, text, options}); },
    async reply(message, text, options) { await onReply?.(message, text, options); replies.push({message, text, options}); },
    async invoke() { assert.fail('unexpected invoke'); },
    async getReply() { return undefined; },
    async withClient() { assert.fail('unexpected native call'); },
  }});
  await host.load(createHitokoto());
  t.after(async () => { assert.equal((await host.shutdown(1000)).completed, true); await fs.rm(root, {recursive: true, force: true}); });
  return {edits, replies, requests, errors, shutdown: () => host.shutdown(1000), unload: timeout => host.unload('hitokoto', timeout), run: text => host.dispatchPrimary({...envelope, text})};
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
  assert.match(f.edits.at(-1).text, /📚 《来源》（动画） - 作者/);
  assert.equal(f.edits.at(-1).options.parseMode, 'html');
});

test('hitokoto ignores invalid types like the original plugin and hides malformed API data', async t => {
  const invalid = await fixture(t);
  await invalid.run('.hitokoto z A a c');
  assert.equal(invalid.requests.length, 1);
  assert.deepEqual(invalid.requests[0].url.searchParams.getAll('c'), ['a', 'a', 'c']);
  const malformed = await fixture(t, {body: {hitokoto: {secret: 'token'}}});
  await malformed.run('.hitokoto a');
  assert.equal(malformed.requests.length, 1, 'a successful malformed response is not a transport retry');
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
  await assert.rejects(pending, error => error?.name === 'AbortError' || error?.name === 'TelegramAbortError');
  assert.equal(f.requests.length, 1);
  assert.equal(f.edits.length, 1);
});

test('hitokoto unload waits for HTTP response-body cancellation to settle', async t => {
  let reading, cancelStarted, release;
  const readReady = new Promise(resolve => { reading = resolve; });
  const cancelReady = new Promise(resolve => { cancelStarted = resolve; });
  const cancelGate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {fetch: async () => new Response(new ReadableStream({
    pull() { reading(); },
    cancel() { cancelStarted(); return cancelGate; },
  }))});
  const pending = f.run('.hitokoto');
  await readReady;
  const first = f.unload(10);
  await cancelReady;
  assert.equal((await first).completed, false);
  release();
  await assert.rejects(pending, error => error?.name === 'AbortError' || error?.name === 'TelegramAbortError');
  assert.equal((await f.unload(1000)).completed, true);
  assert.equal(f.edits.length, 1, 'cancellation must not render a late failure');
});

test('hitokoto paginates a maximally escaped quote without dropping content', async t => {
  const f = await fixture(t, {body: {hitokoto: '&'.repeat(2000)}});
  await f.run('.hitokoto');
  const pages = [f.edits.at(-1).text, ...f.replies.map(reply => reply.text)];
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= 3500));
  assert.equal((pages.join('').match(/&amp;/g) || []).length, 2000);
});

test('hitokoto contains a response-body cleanup rejection during cancellation', async t => {
  let reading;
  const ready = new Promise(resolve => { reading = resolve; });
  const f = await fixture(t, {fetch: async () => new Response(new ReadableStream({
    pull() { reading(); },
    cancel() { throw new Error('SECRET_BODY_CLEANUP'); },
  }))});
  const pending = f.run('.hitokoto');
  await ready;
  assert.equal((await f.shutdown()).completed, true);
  await assert.rejects(pending, error => error?.name === 'AbortError' || error?.name === 'TelegramAbortError');
  assert.equal(f.edits.length, 1);
});

test('hitokoto reports a fixed delivery failure when the first result page cannot publish', async t => {
  let editCalls = 0;
  const f = await fixture(t, {onEdit: async () => {
    editCalls++;
    if (editCalls === 2) throw new Error('SECRET_FIRST_PAGE_FAILURE');
  }});
  await f.run('.hitokoto');
  assert.equal(f.requests.length, 1, 'delivery failure must not retry HTTP');
  assert.equal(f.edits.length, 2);
  assert.equal(f.edits.at(-1).text, '<b>一言失败</b>\n获取一言失败，请稍后重试');
  assert.deepEqual(f.errors.at(-1), ['hitokoto_delivery_failed', {kind: 'Error', published: 0, total: 1}]);
  assert.doesNotMatch(JSON.stringify(f.edits), /SECRET_FIRST_PAGE_FAILURE/);
});

test('hitokoto keeps the first page and posts an interruption notice when page two fails', async t => {
  let replyCalls = 0;
  const f = await fixture(t, {body: {hitokoto: '&'.repeat(2000)}, onReply: async () => {
    replyCalls++;
    if (replyCalls === 1) throw new Error('page two transport failed');
  }});
  await f.run('.hitokoto');
  assert.equal(f.requests.length, 1, 'partial delivery must not retry HTTP');
  assert.match(f.edits.at(-1).text, /1\/\d+ 页$/);
  assert.ok(f.edits.at(-1).text.length > 0, 'the published first page remains visible');
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0].text, /已发送 1\/\d+ 页，后续页发送中断/);
  assert.deepEqual(f.errors.at(-1), ['hitokoto_delivery_failed', {kind: 'Error', published: 1, total: 4}]);
});
