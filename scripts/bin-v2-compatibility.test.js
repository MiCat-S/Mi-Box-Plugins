'use strict';
// Compatibility checks for the active V2 command against bin/bin.ts.
// The real PluginHost is used with simulated HTTP and Telegram adapters.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'bin', packageRoot: path.resolve(__dirname, '../bin'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t, fetchImpl, editImpl) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bin-compat-')));
  const edits = [], requests = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {
    fetch: async (url, init) => {requests.push({url: String(url), init}); return fetchImpl(url, init);},
  }, telegram: {async edit(_m, text, options) {
    if (editImpl) return editImpl({text, options, edits});
    edits.push({text, options});
  }, async reply() {},
    async invoke() {}, async getReply() {}, async withClient() {}}});
  await host.load(create());
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  return {host, edits, requests, send: (args) => host.dispatchPrimary({id: 1, chatId: 'chat', senderId: 'owner', outgoing: true, text: `.bin ${args}`})};
}

const rates = {result: 'success', base_code: 'USD', time_last_update_unix: 1788912000, rates: {USD: 1, CNY: 7, TWD: 32}};
function successFetch(url) {
  const value = String(url);
  if (value.includes('bincheck.io')) return new Response('<meta property="og:description" content="valid BIN number VISA issued by Taiwan Company Limited in Taiwan">');
  if (value.includes('open.er-api.com')) return new Response(JSON.stringify(rates));
  return new Response(JSON.stringify({scheme: 'visa', type: 'credit', brand: 'gold', prepaid: false,
    bank: {name: 'fallback bank'}, country: {name: 'Taiwan, Province of China', alpha2: 'TW', currency: 'TWD'}}));
}

test('BIN-COMPAT-01 strips non-digits before validating, as the original command did', async t => {
  const f = await fixture(t, successFetch);
  await f.send('4150-42');
  assert.match(f.edits.at(-1).text, /<code>415042<\/code>/);
  assert.ok(f.requests.some(request => request.url.endsWith('/415042')));
});

test('BIN-COMPAT-02 a second h/help token displays help without provider calls', async t => {
  const f = await fixture(t, successFetch);
  await f.send('415042 help');
  assert.match(f.edits.at(-1).text, /BIN 查询/);
  assert.equal(f.requests.length, 0);
});

test('BIN-COMPAT-03 sends Binlist API version 3 and keeps original bank precedence and formatting', async t => {
  const f = await fixture(t, successFetch);
  await f.send('415042');
  const lookup = f.requests.find(request => request.url.includes('lookup.binlist.net'));
  assert.equal(new Headers(lookup.init.headers).get('Accept-Version'), '3');
  const output = f.edits.at(-1).text;
  assert.match(output, /国家\s+🇹🇼 台湾/);
  assert.match(output, /卡行\s+TAIWAN CO\., LTD\./);
  assert.doesNotMatch(output, /Province of China|fallback bank/i);
});

for (const [name, status, expected] of [['not found', 404, '❌ 未找到: <code>415042</code>'], ['rate limited', 429, '⏳ 频率受限，请稍后重试']]) {
  test(`BIN-COMPAT-04 preserves the original ${name} result`, async t => {
    const f = await fixture(t, url => String(url).includes('bincheck.io') ? new Response('') :
      String(url).includes('open.er-api.com') ? new Response('{}', {status: 503}) : new Response('', {status}));
    await f.send('415042');
    assert.equal(f.edits.at(-1).text, expected);
  });
}

test('BIN-COMPAT-05 does not disclose error message, name, or cause', async t => {
  const secret = 'api-key-secret-123';
  const failure = new Error(`provider leaked ${secret}`, {cause: new Error(`cause ${secret}`)});
  failure.name = `SecretError-${secret}`;
  const f = await fixture(t, url => {
    if (String(url).includes('lookup.binlist.net')) throw failure;
    return successFetch(url);
  });
  await f.send('415042');
  assert.equal(f.edits.at(-1).text, 'BIN 查询失败，请稍后重试');
  assert.doesNotMatch(JSON.stringify(f.edits), new RegExp(secret));
});

test('BIN-COMPAT-06 releases the Binlist response body after a normal read', async t => {
  let body;
  const f = await fixture(t, url => {
    if (!String(url).includes('lookup.binlist.net')) return successFetch(url);
    const response = successFetch(url); body = response.body; return response;
  });
  await f.send('415042');
  assert.equal(body.locked, false);
  assert.match(f.edits.at(-1).text, /BIN · 卡片档案/);
});

test('BIN-COMPAT-06 bounds the Binlist body and releases it on overflow', async t => {
  let body;
  const f = await fixture(t, url => {
    if (!String(url).includes('lookup.binlist.net')) return successFetch(url);
    const response = new Response(new Uint8Array(256 * 1024 + 1)); body = response.body; return response;
  });
  await f.send('415042');
  assert.equal(body.locked, false);
  assert.equal(f.edits.at(-1).text, 'BIN 查询失败，请稍后重试');
});

test('BIN-COMPAT-06 cancellation unlocks a pending body and sends no late result', async t => {
  let body, cancelled = false, lookupStarted;
  const started = new Promise(resolve => {lookupStarted = resolve;});
  const f = await fixture(t, url => {
    if (!String(url).includes('lookup.binlist.net')) return successFetch(url);
    const response = new Response(new ReadableStream({
      start() { lookupStarted(); },
      cancel() { cancelled = true; },
    }));
    body = response.body;
    return response;
  });
  const running = f.send('415042');
  await started;
  assert.equal((await f.host.unload('bin', 1000)).completed, true);
  await running;
  await new Promise(setImmediate);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.deepEqual(f.edits.map(item => item.text), ['正在查询 BIN…']);
});
