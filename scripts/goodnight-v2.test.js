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

test('goodnight declares no scheduled jobs or background setup', () => {
  const plugin = create();
  assert.equal(plugin.jobs, undefined);
  assert.equal(plugin.setup, undefined);
});

async function fixture(t, initial, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-goodnight-v2-')));
  if (initial) {
    await fs.mkdir(path.join(root, 'goodnight'));
    await fs.writeFile(path.join(root, 'goodnight/data.json'), JSON.stringify(initial));
  }
  const edits = [], replies = [], errors = [];
  const host = new PluginHost({storageRoot: root, prefixes: options.prefixes, logger: {info() {}, error(event) { errors.push(event); }}, telegram: {
    async edit(message, text, options) { edits.push({text, options}); },
    async reply(message, text, replyOptions) {replies.push({message, text, options: replyOptions}); await options.reply?.();},
    async invoke() {}, async getReply() {}, async withClient() {},
  }});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  return {edits, errors, host, replies, read: async () => JSON.parse(await fs.readFile(path.join(root, 'goodnight/data.json'), 'utf8')),
    command: (text, chatId = 'chat') => host.dispatchPrimary({id: 1, chatId, senderId: 'owner', outgoing: true, text}),
    message: (text, senderId, extra = {}) => host.dispatchListeners({id: Date.now(), chatId: 'chat', senderId, outgoing: false, text, ...extra})};
}

test('goodnight toggles and configures timezone', async t => {
  const f = await fixture(t);
  await f.command('.goodnight on');
  await f.command('.goodnight utc+8');
  await f.command('.goodnight');
  assert.match(f.edits.at(-1).text, /当前状态: ✅ 开启/);
  assert.match(f.edits.at(-1).text, /当前时区: UTC\+8/);
});

test('goodnight listener counts each sender once', async t => {
  const f = await fixture(t);
  await f.command('.goodnight on');
  await f.message('晚安', 'u1');
  await f.message('晚安', 'u1');
  await f.message('早安', 'u2');
  const group = (await f.read()).groups.chat;
  assert.deepEqual(group.sleepUsers, ['u1']);
  assert.deepEqual(group.wakeUsers, ['u2']);
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
  let g = (await f.read()).groups.chat;
  assert.equal(g.timezone, -12);
  assert.deepEqual(g.sleepUsers, ['old']);
  await f.message('早安', 'new');
  g = (await f.read()).groups.chat;
  assert.deepEqual(g.sleepUsers, []);
  assert.deepEqual(g.wakeUsers, ['new']);
  assert.equal(g.sleep, undefined);
});

test('goodnight and gn help use the active prefix and invalid text shows live status', async t => {
  const f = await fixture(t, undefined, {prefixes: ['!']});
  await f.command('!goodnight help');
  assert.match(f.edits.at(-1).text, /!goodnight on\/off/);
  assert.match(f.edits.at(-1).text, /!gn/);
  await f.command('!gn nonsense');
  assert.match(f.edits.at(-1).text, /当前状态: 🚫 关闭/);
  assert.match(f.edits.at(-1).text, /!goodnight utc\+8/);
  await f.command('!gn utc+8suffix');
  assert.match(f.edits.at(-1).text, /UTC\+8/);
});

test('goodnight escapes an HTML-bearing active prefix in dynamic status and shared help', async t => {
  const f = await fixture(t, undefined, {prefixes: ['<&']});
  await f.command('<&goodnight');
  assert.match(f.edits.at(-1).text, /<code>&lt;&amp;goodnight on\/off<\/code>/);
  assert.doesNotMatch(f.edits.at(-1).text, /<code><&/);
  await f.command('<&gn help');
  assert.match(f.edits.at(-1).text, /<code>&lt;&amp;gn<\/code>/);
});

test('goodnight truncates long sender names without splitting an emoji surrogate pair', async t => {
  const f = await fixture(t);
  await f.command('.goodnight on');
  await f.message('晚安', 'emoji', {raw: {sender: {firstName: `${'a'.repeat(127)}😀tail`}}});
  assert.match(f.replies.at(-1).text, new RegExp(`${'a'.repeat(127)}😀!`));
  assert.doesNotMatch(f.replies.at(-1).text, /tail/);
});

test('goodnight keeps ranking data when reply fails and logs only a fixed event', async t => {
  const f = await fixture(t, undefined, {reply: async () => { throw Object.assign(new Error('private message'), {code: 'PRIVATE'}); }});
  await f.command('.goodnight on');
  await f.message('晚安', '900719925474099312345');
  assert.deepEqual((await f.read()).groups.chat.sleepUsers, ['900719925474099312345']);
  assert.deepEqual(f.errors, ['goodnight.reply_failed']);
});

test('goodnight cancellation during sender lookup produces no late reply or error', async t => {
  const lookup = Promise.withResolvers();
  const f = await fixture(t);
  await f.command('.goodnight on');
  const running = f.message('晚安', 'u', {raw: {getSender: async () => lookup.promise}});
  await new Promise(resolve => setImmediate(resolve));
  const unloading = f.host.unload('goodnight');
  lookup.resolve({firstName: 'late'});
  assert.equal((await unloading).completed, true);
  await assert.rejects(running, AggregateError);
  assert.deepEqual(f.replies, []);
  assert.deepEqual(f.errors, []);
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
  await f.message('早安', 'forwarded', {forwarded: true});
  assert.equal(f.replies.length, 2);
  await f.command('.gn off');
  await f.message('早安', 'u');
  assert.equal(f.replies.length, 2);
});
