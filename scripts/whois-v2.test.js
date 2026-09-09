'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {SqliteStore} = require(path.join(core, 'dist/v2/sqlite.js'));
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
  const sql = new SqliteStore(path.join(root, 'whois/records.sqlite'));
  t.after(() => sql.close());
  return {root, sql, edits, requests, setReply(value) {reply = value;},
    read: () => sql.read(db => ({...JSON.parse(db.prepare('SELECT value FROM metadata WHERE id = 1').get().value),
      history: db.prepare('SELECT value FROM history ORDER BY id DESC').all().map(row => JSON.parse(row.value)),
      cache: Object.fromEntries(db.prepare('SELECT domain, value FROM cache').all().map(row => [row.domain, JSON.parse(row.value)])),
    })),
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

test('whois migration preserves all records, extension fields, order and source snapshots', async t => {
  const history = Array.from({length: 25}, (_, i) => ({domain: `d${i}.com`, queryTime: '2026-09-01T12:34:56Z', rawData: `full body ${i}`, extra: {index: i}}));
  const initial = {history, cache: Object.fromEntries(history.map(item => [item.domain, item])), settings: {maxHistory: 2}, extension: ['kept']};
  const f = await fixture(t, initial);
  assert.deepEqual(await f.read(), initial);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, 'whois/data.json'), 'utf8')), initial);
  await f.run('.whois history');
  const output = f.edits.at(-1).text;
  assert.match(output, /共 25 条，缓存 25 个/);
  assert.ok(output.indexOf('d0.com') < output.indexOf('d19.com'));
  assert.doesNotMatch(output, /d20\.com|full body/);
  await f.reload();
  assert.deepEqual(await f.read(), initial);
});

test('whois legacy import deduplicates by complete record and keeps current cache precedence', async t => {
  const a = {domain: 'a.com', queryTime: 'same', rawData: 'a', extra: 'first'};
  const b = {...a, rawData: 'b'};
  const f = await fixture(t, {history: [a, {...a}], cache: {'a.com': a}, settings: {maxHistory: 1}},
    {history: [{...a, extra: 'legacy'}, b], cache: {'a.com': b}, settings: {cacheHours: 48}});
  const value = await f.read();
  assert.deepEqual(value.history, [a, b]);
  assert.deepEqual(value.cache, {'a.com': a});
  assert.deepEqual(value.settings, {maxHistory: 1, cacheHours: 48});
});

test('whois can import a legacy file added after initialization exactly once', async t => {
  const f = await fixture(t);
  await f.run('.whois example.com');
  const item = {domain: 'legacy.com', rawData: 'kept', queryTime: '2000-01-01T00:00:00Z'};
  await fs.writeFile(path.join(f.root, 'whois/whois_data.json'), JSON.stringify({history: [item], cache: {'legacy.com': item}}));
  await f.reload();
  assert.deepEqual((await f.read()).history.map(row => row.domain), ['example.com', 'legacy.com']);
  await f.run('.whois clear');
  await f.reload();
  assert.deepEqual((await f.read()).history, []);
  assert.deepEqual((await f.read()).cache, {});
});

test('whois history and cache writes roll back together on a database failure', async t => {
  const f = await fixture(t);
  await f.run('.whois example.com');
  const before = await f.read();
  await f.sql.transaction(db => db.exec("CREATE TRIGGER reject_cache BEFORE INSERT ON cache BEGIN SELECT RAISE(ABORT, 'injected write failure'); END"));
  await f.run('.whois example.org');
  assert.deepEqual(await f.read(), before);
  assert.match(f.edits.at(-1).text, /未取得 WHOIS 数据/);
  await f.sql.transaction(db => db.exec('DROP TRIGGER reject_cache'));
  await f.run('.whois example.org');
  assert.deepEqual((await f.read()).history.map(row => row.domain), ['example.org', 'example.com']);
});

test('whois fractional history limit preserves zero-history behavior and complete cache', async t => {
  const f = await fixture(t, {history: [], cache: {}, settings: {maxHistory: 0.5}});
  await f.run('.whois example.com');
  const data = await f.read();
  assert.deepEqual(data.history, []);
  assert.equal(data.cache['example.com'].rawData, 'Registrar: Example');
  await f.run('.whois example.com');
  assert.equal(f.requests.length, 1);
});

test('whois normal commands and reload do not read migrated JSON snapshots', async t => {
  const f = await fixture(t, {history: [], cache: {}, legacyImported: true});
  await fs.writeFile(path.join(f.root, 'whois/data.json'), 'not json');
  await fs.writeFile(path.join(f.root, 'whois/whois_data.json'), 'not json');
  await f.run('.whois example.com');
  await f.run('.whois history');
  await f.reload();
  await f.run('.whois example.com');
  assert.equal(f.requests.length, 1);
  assert.equal((await f.read()).history.length, 1);
});
