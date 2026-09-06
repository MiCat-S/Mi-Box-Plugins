'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {buildPlugin} = require('../../TeleBox-Core/scripts/build-v2-plugin.cjs');
const {artifactDir} = buildPlugin({id: 'pangu', packageRoot: path.resolve(__dirname, '../pangu'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const fs = require('node:fs/promises');
const os = require('node:os');
const {StorageRoot} = require('../../TeleBox-Core/dist/v2/storage.js');

async function run(text) {
  const pages = [];
  const edit = async (_, value) => pages.push(value);
  await create().commands.pangu.handle({
    message: {text: `.pangu ${text}`, id: 1, chatId: '1', outgoing: true},
    args: text.split(/\s+/), prefix: '.', command: 'pangu',
  }, {signal: new AbortController().signal, telegram: {edit, reply: edit}});
  return pages;
}
test('pangu preserves whitespace and URLs', async () => {
  assert.deepEqual(await run('中文ABC\n\n测试123  https://example.com/a?q=中文'), [
    '中文 ABC\n\n测试 123  https://example.com/a?q=中文',
  ]);
});
test('pangu preserves placeholder-like user text', async () => {
  assert.deepEqual(await run('\u00000\u0000 中文A'), ['\u00000\u0000 中文 A']);
});
test('pangu formats quotes, brackets, hashtags, symbols and extended CJK ranges', async () => {
  const cases = [
    ['中文"English"测试', '中文 &quot;English&quot; 测试'],
    ['中文( English )测试', '中文 (English) 测试'],
    ['中文#tag', '中文 #tag'],
    ['中文+ABC', '中文 +ABC'],
    ['ㄅA', 'ㄅ A'],
    ['中文 https://example.com/a?q=中文&x=(a)', '中文 https://example.com/a?q=中文&amp;x=(a)'],
  ];
  for (const [input, expected] of cases) assert.equal((await run(input)).join(''), expected);
});
test('pangu pages escaped text without truncating content or Unicode', async () => {
  const input = '<&😀'.repeat(2000);
  const pages = await run(input);
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= 3500));
  assert.equal(pages.join(''), '&lt;&amp;😀'.repeat(2000));
});

function listenerFixture(patch = {}) {
  let data = {chats: {}, globalMode: true, whitelist: [], blacklist: [],
    stats: {formattedMessages: 0, lastFormatted: 0}, ...patch};
  const edits = [];
  const ctx = {telegram: {
    async edit(message, text) {edits.push({message, text});},
    async reply() {assert.fail('automatic formatting must edit, never reply');},
  }, storage: {json: () => ({
    async read() {return structuredClone(data);},
    async update(fn) {data = fn(structuredClone(data)); return data;},
  })}};
  const listener = create().listeners[0];
  return {edits, ctx, data: () => data, listener,
    run: extra => listener.handle({id: 1, chatId: '1', senderId: 'owner',
      text: '中文ABC', outgoing: true, ...extra}, ctx)};
}
test('pangu automatic formatting edits outgoing, edited and saved messages only', async () => {
  const f = listenerFixture();
  assert.equal(f.listener.edited, true);
  assert.equal(f.listener.ignoreCommands, true);
  await f.run({outgoing: false});
  assert.equal(f.edits.length, 0);
  await f.run({});
  await f.run({edited: true});
  await f.run({outgoing: false, saved: true});
  assert.equal(f.edits.length, 3);
  assert.ok(f.edits.every(e => e.text === '中文 ABC'));
  assert.equal(f.data().stats.formattedMessages, 3);
  await f.run({text: '中文 ABC'});
  assert.equal(f.edits.length, 3);
});
test('pangu explicit off overrides global and whitelist overrides other switches', async () => {
  const off = listenerFixture({chats: {'1': false}});
  await off.run({});
  assert.equal(off.edits.length, 0);
  const blocked = listenerFixture({blacklist: ['1']});
  await blocked.run({});
  assert.equal(blocked.edits.length, 0);
  const white = listenerFixture({globalMode: false, chats: {'1': false}, blacklist: ['1'], whitelist: ['1']});
  await white.run({});
  await white.run({chatId: '2'});
  assert.equal(white.edits.length, 1);
});
test('pangu failed edits do not increment formatting statistics', async () => {
  const f = listenerFixture();
  f.ctx.telegram.edit = async () => {throw new Error('edit failed');};
  await assert.rejects(f.run({}), /edit failed/);
  assert.equal(f.data().stats.formattedMessages, 0);
});

test('pangu status and reset preserve other chats and restore global inheritance', async () => {
  const f = listenerFixture({chats: {'1': false, '2': true}});
  const command = async args => create().commands.pangu.handle({
    args, command: 'pangu', prefix: '.', message: {id: 1, chatId: '1', outgoing: true, text: '.pangu ' + args.join(' ')},
  }, f.ctx);
  await command([]);
  assert.match(f.edits.at(-1).text, /当前生效: 关闭/);
  await command(['reset']);
  assert.deepEqual(f.data().chats, {'2': true});
  await command([]);
  assert.match(f.edits.at(-1).text, /当前生效: 开启/);
  assert.match(f.edits.at(-1).text, /跟随全局/);
  await command(['disable']);
  assert.equal(f.data().chats['1'], false);
  await command(['enable']);
  assert.equal(f.data().chats['1'], true);
});

async function migrationFixture(t, legacy, current) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pangu-migration-')));
  const root = new StorageRoot(dir);
  t.after(async () => {await root.close(); await fs.rm(dir, {recursive: true, force: true});});
  const storage = {json: (file, defaults) => root.json('pangu', file, defaults)};
  if (legacy) await storage.json('config.json', {}).update(() => legacy);
  if (current) await storage.json('data.json', {}).update(() => current);
  return {ctx: {storage}, db: storage.json('data.json', {}), legacy: storage.json('config.json', {})};
}

test('pangu imports legacy switches, lists, nullable timestamp and metadata once', async t => {
  const legacy = {version: '1.0.0', chats: {'1': true}, globalMode: true,
    whitelist: ['1'], blacklist: ['2'],
    stats: {formattedMessages: 42, lastFormatted: null, enabledChats: 1}};
  const f = await migrationFixture(t, legacy);
  await create().setup(f.ctx);
  assert.deepEqual(await f.db.read(), {...legacy, legacyImported: true});
  await f.db.update(data => ({...data, whitelist: [], globalMode: false, chats: {}}));
  await create().setup(f.ctx);
  const updated = await f.db.read();
  assert.deepEqual(updated.whitelist, []);
  assert.deepEqual(updated.chats, {});
  assert.equal(updated.globalMode, false);
  assert.deepEqual(await f.legacy.read(), legacy);
});

test('pangu preserves explicit V2 values and merges legacy chat and statistics metadata', async t => {
  const f = await migrationFixture(t, {
    chats: {'1': true, '2': true}, globalMode: true, whitelist: ['1'], blacklist: ['2'],
    stats: {formattedMessages: 42, lastFormatted: null, enabledChats: 2},
  }, {chats: {'1': false}, globalMode: false, whitelist: [],
    stats: {formattedMessages: 50}, custom: 'retained'});
  await create().setup(f.ctx);
  const data = await f.db.read();
  assert.deepEqual(data.chats, {'1': false, '2': true});
  assert.equal(data.globalMode, false);
  assert.deepEqual(data.whitelist, []);
  assert.deepEqual(data.blacklist, ['2']);
  assert.deepEqual(data.stats, {formattedMessages: 50, lastFormatted: null, enabledChats: 2});
  assert.equal(data.custom, 'retained');
});

test('pangu setup without legacy data allows later import and formatting preserves metadata', async t => {
  const f = await migrationFixture(t);
  await create().setup(f.ctx);
  assert.deepEqual(await f.db.read(), {});
  await f.legacy.update(() => ({globalMode: true, stats: {formattedMessages: 9, lastFormatted: null, enabledChats: 3}}));
  await create().setup(f.ctx);
  f.ctx.telegram = {async edit() {}};
  await create().listeners[0].handle({text: '中文ABC', chatId: '1', outgoing: true}, f.ctx);
  const data = await f.db.read();
  assert.equal(data.stats.formattedMessages, 10);
  assert.equal(data.stats.enabledChats, 3);
  assert.equal(typeof data.stats.lastFormatted, 'number');
});
