'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'whois', packageRoot: path.resolve(__dirname, '../whois'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t, initial, legacy) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-whois-v2-')));
  if (initial) {
    await fs.mkdir(path.join(root, 'whois'));
    await fs.writeFile(path.join(root, 'whois/data.json'), JSON.stringify(initial));
  }
  if (legacy) {
    await fs.mkdir(path.join(root, 'whois'), {recursive: true});
    await fs.writeFile(path.join(root, 'whois/whois_data.json'), JSON.stringify(legacy));
  }
  const edits = [], requests = [];
  let reply;
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {
    fetch: async url => {requests.push(String(url)); return new Response('data: {"type":"check","data":{"whois":{"whois":"Registrar: Example"}}}\n\n', {status: 200});},
  }, telegram: {
    async edit(message, text, options) { edits.push({text, options}); }, async reply(message, text, options) {edits.push({text, options});},
    async invoke() {}, async getReply() {return reply;}, async withClient() {},
  }});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  return {edits, requests, setReply(value) {reply = value;},
    read: async () => JSON.parse(await fs.readFile(path.join(root, 'whois/data.json'), 'utf8')),
    readLegacy: async () => JSON.parse(await fs.readFile(path.join(root, 'whois/whois_data.json'), 'utf8')),
    reload: async () => {await host.unload('whois'); await host.load(create());},
    run: text => host.dispatchPrimary({id: 1, chatId: 'chat', senderId: 'owner', outgoing: true, text})};
}

test('whois help and validation stay local', async t => {
  const f = await fixture(t);
  await f.run('.whois help');
  await f.run('.whois bad_input');
  assert.match(f.edits[0].text, /WHOIS/);
  assert.match(f.edits.at(-1).text, /有效域名/);
});

test('whois parses bounded SSE response', async t => {
  const f = await fixture(t);
  await f.run('.whois example.com');
  assert.match(f.edits.at(-1).text, /Registrar: Example/);
  assert.equal(f.edits.at(-1).options.parseMode, 'html');
});

test('whois caches results and supports history and clear', async t => {
  const f = await fixture(t);
  await f.run('.whois example.com');
  await f.run('.whois example.com');
  assert.equal(f.edits.filter(item => /WHOIS 结果/.test(item.text)).length, 2);
  await f.run('.whois history');
  assert.match(f.edits.at(-1).text, /example\.com/);
  await f.run('.whois clear');
  assert.match(f.edits.at(-1).text, /历史 1 条/);
});

test('whois batch validates each domain and returns bounded summary', async t => {
  const f = await fixture(t);
  await f.run('.whois batch example.com bad_input example.org');
  assert.match(f.edits.at(-1).text, /批量查询/);
  assert.match(f.edits.at(-1).text, /格式无效/);
  assert.match(f.edits.at(-1).text, /example\.org/);
});

test('whois reply and batch share cached results without duplicate requests', async t => {
  const f = await fixture(t);
  f.setReply({id: 2, text: '查询 https://www.example.com/path', chatId: 'chat'});
  await f.run('.whois');
  assert.equal(f.requests.length, 1);
  await f.run('.whois batch example.com EXAMPLE.COM example.org');
  assert.equal(f.requests.length, 2);
  assert.match(f.edits.at(-1).text, /example\.org/);
  await f.run('.whois clear');
  await f.run('.whois example.com');
  assert.equal(f.requests.length, 3);
});

test('whois expired and future-dated caches are refreshed', async t => {
  for (const queryTime of ['2000-01-01T00:00:00Z', '2999-01-01T00:00:00Z', 'invalid']) {
    const f = await fixture(t, {history: [], cache: {'example.com': {domain: 'example.com', rawData: 'stale', queryTime}}});
    await f.run('.whois batch example.com');
    assert.equal(f.requests.length, 1);
    await f.run('.whois example.com');
    assert.equal(f.requests.length, 1);
    assert.doesNotMatch(f.edits.at(-1).text, /stale/);
  }
});

test('whois imports legacy records once and preserves current data and settings', async t => {
  const item = {domain: 'example.com', rawData: 'legacy', queryTime: new Date().toISOString()};
  const legacy = {history: [item], cache: {'example.com': item},
    settings: {cacheHours: 48, maxHistory: 2, enableNotifications: false}, marker: 'keep'};
  const current = {...item, rawData: 'current'};
  const f = await fixture(t, {history: [current], cache: {'example.com': current}}, legacy);
  await f.run('.whois example.com');
  assert.equal(f.requests.length, 0);
  assert.match(f.edits.at(-1).text, /current/);
  assert.deepEqual(await f.readLegacy(), legacy);
  assert.equal((await f.read()).history.length, 2);
  assert.equal((await f.read()).marker, 'keep');
  await f.run('.whois clear');
  await f.reload();
  assert.equal((await f.read()).history.length, 0);
  assert.equal((await f.read()).settings.cacheHours, 48);
});

test('whois retains legacy cache duration and history limit', async t => {
  const item = {domain: 'example.com', rawData: 'cached', queryTime: new Date(Date.now() - 25 * 3600000).toISOString()};
  const f = await fixture(t, undefined, {history: [item], cache: {'example.com': item}, settings: {cacheHours: 48, maxHistory: 2}});
  await f.run('.whois example.com');
  assert.equal(f.requests.length, 0);
  await f.run('.whois batch example.org example.net example.io');
  assert.equal((await f.read()).history.length, 2);
  assert.equal(f.requests.length, 3);
});
