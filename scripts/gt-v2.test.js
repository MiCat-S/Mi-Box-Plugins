'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'gt', packageRoot: path.resolve(__dirname, '../gt'), entry: 'v2.ts'});
const createGt = require(path.join(artifactDir, 'index.cjs')).default;
const envelope = {id: 1, chatId: '9007199254740993', senderId: '123', outgoing: true, text: '.gt Hello'};

async function fixture(t, {translate = async () => 'translated', reply, response} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-gt-v2-')));
  const edits = [], replies = [], requests = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch: async (url, init) => {
    assert.equal(String(url), 'https://translate.google.com/translate_a/single?client=at&dt=t&dt=rm&dj=1');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('sl'), 'auto');
    const input = {text: params.get('q'), target: params.get('tl')};
    requests.push({input, signal: init.signal});
    if (response) return response();
    return Response.json({sentences: [{trans: await translate(input, init.signal)}]});
  }}, telegram: {
    async edit(message, text, options, signal) { edits.push({message, text, options, signal}); },
    async reply(message, text, options, signal) { replies.push({message, text, options, signal}); },
    async getReply() { return reply && {...envelope, text: reply, id: 2}; },
    async withClient() { assert.fail('unexpected native call'); },
    async invoke() { assert.fail('unexpected RPC'); },
  }});
  await host.load(createGt());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {host, edits, replies, requests, run: text => host.dispatchPrimary({...envelope, text})};
}

test('v2 gt help describes Google translation', async t => {
  const {run, edits, requests} = await fixture(t, {ai: false});
  await run('.gt HELP');
  assert.match(edits[0].text, /Google 翻译/);
  assert.match(edits[0].text, /无需配置 API Key/);
  assert.equal(requests.length, 0);
});

test('v2 gt preserves paragraphs, target selection, message IDs and escaping', async t => {
  const {run, edits, requests} = await fixture(t, {translate: async () => '<你好>&'});
  await run('.gt Hello\n\nworld');
  assert.deepEqual(requests[0].input, {text: 'Hello\n\nworld', target: 'zh-CN'});
  assert.match(edits.at(-1).text, /&lt;你好&gt;&amp;/);
  assert.equal(edits.at(-1).message.chatId, envelope.chatId);
  await run('.gt\tEN\t你好\n世界');
  assert.deepEqual(requests[1].input, {text: '你好\n世界', target: 'en'});
});

test('v2 gt reply translation retains content and rejects absent or overlong text', async t => {
  const withReply = await fixture(t, {reply: '你好\n世界'});
  await withReply.run('.gt EN');
  assert.deepEqual(withReply.requests[0].input, {text: '你好\n世界', target: 'en'});
  const empty = await fixture(t);
  await empty.run('.gt');
  assert.match(empty.edits.at(-1).text, /请提供/);
  await empty.run('.gt ' + 'a'.repeat(5001));
  assert.match(empty.edits.at(-1).text, /5000/);
  assert.equal(empty.requests.length, 0);
});

test('v2 gt joins Google segments without an AI plugin', async t => {
  const {run, edits} = await fixture(t, {response: () => Response.json({sentences: [{trans: '你好'}, {src_translit: 'ignored'}, {trans: '世界'}]})});
  await run('.gt Hello');
  assert.match(edits.at(-1).text, /你好世界/);
});

test('v2 gt rejects HTTP errors, malformed and oversized responses', async t => {
  for (const response of [
    () => new Response('secret-ip', {status: 429}),
    () => new Response('not-json-secret-ip'),
    () => Response.json({sentences: null}),
    () => new Response('x'.repeat(256 * 1024 + 1)),
  ]) {
    const {run, edits} = await fixture(t, {response});
    await run('.gt hello');
    assert.match(edits.at(-1).text, /Google 翻译失败/);
    assert.doesNotMatch(JSON.stringify(edits), /secret-ip/);
  }
});

test('v2 gt streams output chunks without breaking surrogate pairs or losing text', async t => {
  const translated = 'a'.repeat(2999) + '😀' + 'b'.repeat(3500);
  const {run, edits, replies} = await fixture(t, {translate: async () => translated});
  await run('.gt Hello');
  const chunks = [edits.at(-1).text.split('<b>译文:</b>\n')[1], ...replies.map(value => value.text)];
  assert.equal(chunks.join(''), translated);
  assert.ok(chunks.every(chunk => chunk.length <= 3000));
  assert.equal(chunks[1].startsWith('😀'), true);
});

test('v2 gt sanitizes provider failures and invalid output', async t => {
  for (const translate of [async () => { throw new Error('secret-api-key'); }, async () => ' ', async () => ({secret: 'secret-api-key'})]) {
    const {run, edits} = await fixture(t, {translate});
    await run('.gt Hello');
    assert.match(edits.at(-1).text, /Google 翻译失败/);
    assert.doesNotMatch(JSON.stringify(edits), /secret-api-key/);
  }
});

test('v2 gt unload cancels the provider and suppresses late translation output', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const {run, host, edits, requests} = await fixture(t, {translate: (_input, signal) => new Promise(resolve => {
    started();
    signal.addEventListener('abort', () => resolve('late'), {once: true});
  })});
  const running = run('.gt Hello');
  await ready;
  assert.equal((await host.unload('gt')).completed, true);
  await running;
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(edits.length, 1);
});

test('v2 gt command respects owner admission and edited message policy', async t => {
  const {host, requests} = await fixture(t);
  assert.equal(await host.dispatchPrimary({...envelope, outgoing: false}), false);
  assert.equal(await host.dispatchPrimary({...envelope, edited: true}), false);
  assert.equal(requests.length, 0);
});
