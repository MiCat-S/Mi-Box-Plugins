'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'aff', packageRoot: path.resolve(__dirname, '../aff'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t, initial) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-aff-v2-')));
  if (initial) {
    await fs.mkdir(path.join(root, 'aff'));
    await fs.writeFile(path.join(root, 'aff/data.json'), JSON.stringify(initial));
  }
  const edits = [];
  let reply;
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(message, text, options) { edits.push({text, options}); }, async reply() {},
    async invoke() {}, async getReply() { return reply; }, async withClient() {},
  }});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  return {edits, read: async () => JSON.parse(await fs.readFile(path.join(root, 'aff/data.json'), 'utf8')), setReply(value) { reply = value; }, run: text => host.dispatchPrimary({id: 1, chatId: 'chat', senderId: 'owner', outgoing: true, text})};
}

test('aff saves, lists, sends and removes entries', async t => {
  const f = await fixture(t);
  f.setReply({id: 2, chatId: 'chat', senderId: 'u', outgoing: false, text: 'https://example.com/aff'});
  await f.run('.aff save');
  await f.run('.aff');
  assert.match(f.edits.at(-1).text, /example\.com/);
  assert.equal(f.edits.at(-1).options.linkPreview, false);
  await f.run('.aff list');
  assert.match(f.edits.at(-1).text, /Aff 列表/);
  await f.run('.aff remove 1');
  assert.match(f.edits.at(-1).text, /已删除/);
});

test('aff reads legacy entries and migrates singleton once while preserving metadata', async t => {
  const f = await fixture(t, {affs: [{text: '<b>old</b>', web_page: true, created_at: 123}],
    aff: {text: 'singleton', web_page: false}, marker: 'preserved'});
  await f.run('.aff 1');
  assert.equal(f.edits.at(-1).text, '<b>old</b>');
  assert.equal(f.edits.at(-1).options.parseMode, 'html');
  assert.equal(f.edits.at(-1).options.linkPreview, false);
  await f.run('.aff 2');
  assert.equal(f.edits.at(-1).text, 'singleton');
  assert.equal(f.edits.at(-1).options.linkPreview, true);
  const data = await f.read();
  assert.equal(data.aff, undefined);
  assert.equal(data.affs.length, 2);
  assert.equal(data.affs[0].created_at, 123);
  await f.run('.aff remove 2');
  assert.equal((await f.read()).marker, 'preserved');
});

test('aff paginates imported lists with bounded escaped Unicode previews', async t => {
  const f = await fixture(t, {affs: Array.from({length: 35}, (_, i) => ({
    text: `entry${i + 1} <&😀`.repeat(50), web_page: false,
  }))});
  for (let page = 1; page <= 4; page++) {
    await f.run(`.aff list ${page}`);
    const {text} = f.edits.at(-1);
    assert.ok(text.length < 3500);
    assert.match(text, new RegExp(`${page}/4`));
    assert.match(text, new RegExp(`entry${(page - 1) * 10 + 1} `));
    assert.ok(text.includes('&lt;&amp;😀'));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text));
  }
  for (const invalid of ['0', '5', '-1', '1.5', 'NaN']) {
    await f.run(`.aff list ${invalid}`);
    assert.match(f.edits.at(-1).text, /页码无效/);
  }
  assert.equal((await f.read()).affs.length, 35);
});

test('aff rejects blank saves and invalid deletion without changing storage', async t => {
  const f = await fixture(t, {affs: [{text: 'keep', webPage: false}]});
  f.setReply({id: 2, chatId: 'chat', text: ' \n '});
  await f.run('.aff save');
  assert.match(f.edits.at(-1).text, /请回复/);
  for (const index of ['0', '-1', '2', '1.5', '1e0']) {
    await f.run(`.aff remove ${index}`);
    assert.match(f.edits.at(-1).text, /序号无效/);
  }
  assert.equal((await f.read()).affs[0].text, 'keep');
});

test('aff preserves existing entries when capacity is reached', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 32; i++) {
    f.setReply({id: 2, chatId: 'chat', text: `entry-${i}`});
    await f.run('.aff save');
  }
  f.setReply({id: 2, chatId: 'chat', text: 'extra'});
  await f.run('.aff save');
  assert.match(f.edits.at(-1).text, /已保存 32 条/);
  await f.run('.aff 1');
  assert.equal(f.edits.at(-1).text, 'entry-0');
  await f.run('.aff 32');
  assert.equal(f.edits.at(-1).text, 'entry-31');
});

test('aff keeps literal markup and refuses oversized text without truncation', async t => {
  const f = await fixture(t);
  f.setReply({id: 2, chatId: 'chat', text: '<b>literal & content</b>'});
  await f.run('.aff save');
  await f.run('.aff 1');
  assert.equal(f.edits.at(-1).text, '<b>literal & content</b>');
  assert.equal(f.edits.at(-1).options.parseMode, undefined);
  f.setReply({id: 2, chatId: 'chat', text: 'a'.repeat(4001)});
  await f.run('.aff save');
  assert.match(f.edits.at(-1).text, /未保存/);
  await f.run('.aff');
  assert.equal(f.edits.at(-1).text, '<b>literal & content</b>');
});
