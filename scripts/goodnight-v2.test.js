'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'goodnight', packageRoot: path.resolve(__dirname, '../goodnight'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t, initial) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-goodnight-v2-')));
  if (initial) {
    await fs.mkdir(path.join(root, 'goodnight'));
    await fs.writeFile(path.join(root, 'goodnight/data.json'), JSON.stringify(initial));
  }
  const edits = [], replies = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(message, text, options) { edits.push({text, options}); },
    async reply(message, text, options) {replies.push({message, text, options});},
    async invoke() {}, async getReply() {}, async withClient() {},
  }});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  return {edits, replies, read: async () => JSON.parse(await fs.readFile(path.join(root, 'goodnight/data.json'), 'utf8')),
    command: (text, chatId = 'chat') => host.dispatchPrimary({id: 1, chatId, senderId: 'owner', outgoing: true, text}),
    message: (text, senderId, extra = {}) => host.dispatchListeners({id: Date.now(), chatId: 'chat', senderId, outgoing: false, text, ...extra})};
}

test('goodnight toggles and configures timezone', async t => {
  const f = await fixture(t);
  await f.command('.goodnight on');
  await f.command('.goodnight utc+8');
  await f.command('.goodnight');
  assert.match(f.edits.at(-1).text, /状态: 开启/);
  assert.match(f.edits.at(-1).text, /晚安: 0 人/);
});

test('goodnight listener counts each sender once', async t => {
  const f = await fixture(t);
  await f.command('.goodnight on');
  await f.message('晚安', 'u1');
  await f.message('晚安', 'u1');
  await f.message('早安', 'u2');
  await f.command('.goodnight');
  assert.match(f.edits.at(-1).text, /晚安: 1 人/);
  assert.match(f.edits.at(-1).text, /早安: 1 人/);
  assert.equal(f.replies.length, 3);
  assert.ok(f.replies.every(reply => reply.text.includes('第 1 个')));
});

test('goodnight preserves legacy rankings and replies to outgoing greetings', async t => {
  const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const f = await fixture(t, {groups: {chat: {enabled: true, date, sleepUsers: ['old'], wakeUsers: []}}});
  await f.message('晚安', 'new', {outgoing: true, raw: {sender: {firstName: '<literal>'}}});
  assert.match(f.replies.at(-1).text, /<literal>.*\n.*第 2 个睡觉/);
  assert.equal(f.replies.at(-1).options.parseMode, undefined);
  await f.message('晚安', 'old');
  assert.match(f.replies.at(-1).text, /第 1 个睡觉/);
  assert.equal((await f.read()).groups.chat.timezone, 8);
});

test('goodnight resets previous days and retains independent concurrent group writes', async t => {
  const f = await fixture(t, {groups: {chat: {enabled: true, timezone: 8, date: '2000-01-01', sleepUsers: ['old'], wakeUsers: ['old']}}});
  await Promise.all([f.command('.gn on', 'other'), f.message('早安', 'new')]);
  const data = await f.read();
  assert.equal(data.groups.other.enabled, true);
  assert.deepEqual(data.groups.chat.sleepUsers, []);
  assert.deepEqual(data.groups.chat.wakeUsers, ['new']);
  assert.match(f.replies.at(-1).text, /第 1 个起床/);
});

test('goodnight timezone changes reset counts only when the calendar day changes', async t => {
  const date = new Date(Date.now() + 14 * 3600000).toISOString().slice(0, 10);
  const f = await fixture(t, {groups: {chat: {enabled: true, timezone: 14, date, sleep: ['old'], wake: []}}});
  await f.command('.gn utc+14');
  assert.deepEqual((await f.read()).groups.chat.sleepUsers, ['old']);
  await f.command('.gn utc-12');
  const g = (await f.read()).groups.chat;
  assert.equal(g.timezone, -12);
  assert.deepEqual(g.sleepUsers, []);
  assert.equal(g.sleep, undefined);
});

test('goodnight matches original keywords exactly and ignores disabled or edited messages', async t => {
  const f = await fixture(t);
  await f.message('晚安', 'u');
  await f.command('.gn on');
  for (const text of ['晚安!', '晚安你好', '今天准备睡了', '.gn']) await f.message(text, 'u');
  await f.message('晚安', 'u', {edited: true});
  assert.equal(f.replies.length, 0);
  await f.message('  晚安喵  ', 'u');
  assert.equal(f.replies.length, 1);
  await f.command('.gn off');
  await f.message('早安', 'u');
  assert.equal(f.replies.length, 1);
});
