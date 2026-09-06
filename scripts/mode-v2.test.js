'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'mode', packageRoot: path.resolve(__dirname, '../mode'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mode-v2-')));
  const edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(message, text) {edits.push(text);},
    async reply() {assert.fail('unexpected reply');},
    async withClient() {assert.fail('unexpected client');},
  }});
  await host.load(create());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {edits, host, listen: patch => host.dispatchListeners({
    id: 2, chatId: '1', senderId: '1', outgoing: true, text: 'text', ...patch,
  }), run: (args, chatId = '1') => host.dispatchPrimary({
    id: 1, chatId, senderId: '1', outgoing: true, text: `.mode ${args}`,
  })};
}
test('mode reports local and global configuration', async t => {
  const f = await fixture(t);
  await f.run('bold');
  await f.run('global italic');
  await f.run('');
  assert.match(f.edits.at(-1), /当前会话: bold/);
  assert.match(f.edits.at(-1), /全局模式: italic/);
  await f.run('global invalid');
  await f.run('global');
  assert.match(f.edits.at(-1), /italic/);
});
test('mode styles outgoing text, skips edited/incoming messages and dynamic commands', async t => {
  const f = await fixture(t);
  await f.run('bold');
  await f.listen({text: '<hello & world>'});
  assert.equal(f.edits.at(-1), '<b>&lt;hello &amp; world&gt;</b>');
  const count = f.edits.length;
  await f.listen({outgoing: false});
  await f.listen({edited: true});
  f.host.replacePrefixes(['!!']);
  await f.listen({text: '!!anything'});
  await f.listen({text: '/start'});
  assert.equal(f.edits.length, count);
  await f.listen({text: '.ordinary'});
  assert.equal(f.edits.at(-1), '<b>.ordinary</b>');
});
test('mode enforces whitelist and blacklist before global formatting', async t => {
  const f = await fixture(t);
  await f.run('global italic');
  await f.run('whitelist add', '2');
  const count = f.edits.length;
  await f.listen({});
  assert.equal(f.edits.length, count);
  await f.listen({chatId: '2'});
  assert.equal(f.edits.at(-1), '<i>text</i>');
  await f.run('blacklist add', '2');
  const blocked = f.edits.length;
  await f.listen({chatId: '2'});
  assert.equal(f.edits.length, blocked);
});
test('mode preserves updates from different chats and deduplicates lists', async t => {
  const f = await fixture(t);
  await Promise.all([f.run('bold', '1'), f.run('italic', '2')]);
  await f.run('', '1');
  assert.match(f.edits.at(-1), /当前会话: bold/);
  await f.run('', '2');
  assert.match(f.edits.at(-1), /当前会话: italic/);
  await Promise.all([f.run('whitelist add', '1'), f.run('whitelist add', '2')]);
  await f.run('whitelist add', '1');
  await f.run('whitelist list');
  assert.equal((f.edits.at(-1).match(/<code>/g) || []).length, 2);
  await f.run('whitelist rm', '1');
  await f.run('whitelist list');
  assert.doesNotMatch(f.edits.at(-1), /<code>1<\/code>/);
  assert.match(f.edits.at(-1), /<code>2<\/code>/);
});
