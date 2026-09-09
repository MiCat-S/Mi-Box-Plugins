'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {StorageRoot} = require(path.join(core, 'dist/v2/storage.js'));
const {SqliteStore} = require(path.join(core, 'dist/v2/sqlite.js'));
const {artifactDir} = buildPlugin({id: 'whois-records', packageRoot: path.resolve(__dirname, '../whois'), entry: 'v2/records.ts'});
const {records} = require(path.join(artifactDir, 'index.cjs'));

async function fixture(t, initial) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-whois-records-')));
  const json = new StorageRoot(root);
  const sql = new SqliteStore(path.join(root, 'whois/records.sqlite'));
  const source = json.json('whois', 'data.json', {history: [], cache: {}});
  if (initial) await source.update(() => initial);
  const controller = new AbortController();
  const api = records({storage: {
    json: (file, defaults) => json.json('whois', file, defaults),
    sqlite: () => ({read: fn => sql.read(fn, controller.signal), transaction: fn => sql.transaction(fn, controller.signal)}),
  }});
  t.after(async () => {await Promise.all([json.close(), sql.close()]); await fs.rm(root, {recursive: true, force: true});});
  return {root, sql, source, controller, api};
}

test('whois interrupted record import rolls back its marker and retries from intact JSON', async t => {
  const item = {domain: 'example.com', rawData: 'body', queryTime: 'time'};
  const initial = {history: [item], cache: {'example.com': item}, legacyImported: true, extension: 9007199254740993123n};
  const f = await fixture(t, initial);
  await f.sql.transaction(db => db.exec(`CREATE TABLE cache (domain TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TRIGGER reject_import BEFORE INSERT ON cache BEGIN SELECT RAISE(ABORT, 'import failure'); END;`));
  await assert.rejects(f.api.initialize(), /import failure/);
  assert.equal(await f.sql.read(db => db.prepare('SELECT count(*) AS n FROM metadata').get().n), 0n);
  assert.equal(await f.sql.read(db => db.prepare('SELECT count(*) AS n FROM history').get().n), 0n);
  assert.deepEqual(await f.source.read(), initial);
  await f.sql.transaction(db => db.exec('DROP TRIGGER reject_import'));
  await f.api.initialize();
  assert.deepEqual((await f.api.lookup('example.com')).cached, item);
  assert.equal((await f.api.history()).history, 1n);
  const meta = await f.sql.read(db => db.prepare('SELECT value FROM metadata').get().value);
  assert.match(meta, /"extension":9007199254740993123/);
});

test('whois failed clear leaves both tables intact and cancellation rejects queued writes', async t => {
  const f = await fixture(t);
  await f.api.initialize();
  const item = {domain: 'example.com', rawData: 'body', queryTime: 'time'};
  await f.api.save(item);
  await f.sql.transaction(db => db.exec("CREATE TRIGGER reject_clear BEFORE DELETE ON cache BEGIN SELECT RAISE(ABORT, 'clear failure'); END"));
  await assert.rejects(f.api.clear(), /clear failure/);
  assert.equal((await f.api.history()).history, 1n);
  assert.deepEqual((await f.api.lookup('example.com')).cached, item);
  f.controller.abort(new Error('unloaded'));
  await assert.rejects(f.api.save({...item, domain: 'other.com'}), /unloaded/);
  assert.equal(await f.sql.read(db => db.prepare('SELECT count(*) AS n FROM cache').get().n), 1n);
});

test('whois concurrent writes retain completion order, configured history size and all cache entries', async t => {
  const f = await fixture(t, {history: [], cache: {}, settings: {maxHistory: 25}});
  await f.api.initialize();
  const items = Array.from({length: 40}, (_, i) => ({domain: `d${i}.com`, rawData: 'x'.repeat(65536), queryTime: String(i)}));
  await Promise.all(items.map(item => f.api.save(item)));
  const history = await f.api.history();
  assert.equal(history.history, 25n);
  assert.equal(history.cache, 40n);
  assert.deepEqual(history.rows.map(row => row.domain), items.slice(-20).reverse().map(item => item.domain));
  assert.ok(history.rows.every(row => !('rawData' in row)));
  assert.deepEqual((await f.api.lookup('d0.com')).cached, items[0]);
  assert.deepEqual(await f.api.clear(), {history: 25n, cache: 40n});
  assert.equal((await f.api.lookup('d0.com')).cached, undefined);
});
