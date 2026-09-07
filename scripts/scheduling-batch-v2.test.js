'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

function load(id) {
  const built = buildPlugin({id, packageRoot: path.resolve(__dirname, `../${id}`), entry: 'v2.ts'});
  delete require.cache[require.resolve(path.join(built.artifactDir, 'index.cjs'))];
  return require(path.join(built.artifactDir, 'index.cjs')).default;
}

async function fixture(t, id, {reply, initial, file, now} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mibot-${id}-`)));
  if (initial) { await fs.mkdir(path.join(root, id), {recursive: true}); await fs.writeFile(path.join(root, id, file), JSON.stringify(initial)); }
  const edits = [], sends = [], invokes = [];
  const client = {
    async getMe() { return {id: 7, firstName: 'Alice 12:30', lastName: 'User'}; },
    async getEntity(value) { return {id: value === 'me' ? 7 : value}; },
    async sendMessage(peer, value) { sends.push({peer, value}); return {id: 100}; },
    async getMessages() { return [{id: 8, message: 'source'}]; },
    async deleteMessages() {}, async pinMessage() {}, async unpinMessage() {},
    async invoke(request) { invokes.push(request); return {}; },
  };
  const host = new PluginHost({storageRoot: root, prefixes: ['.'], logger: {info() {}, error() {}}, telegram: {
    async edit(message, text, options) {edits.push({message, text, options});}, async reply() {},
    async getReply() {return reply;}, async invoke(request) {invokes.push(request); return {};},
    async withClient(operation, signal) {return operation(client, signal);},
  }});
  await host.load(load(id)());
  t.after(async () => {assert.equal((await host.shutdown(1000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  const run = (text, extra = {}) => host.dispatchPrimary({id: 1, chatId: '7', senderId: '7', outgoing: true, text, ...extra});
  return {root, host, edits, sends, invokes, run, read: async name => JSON.parse(await fs.readFile(path.join(root, id, name), 'utf8'))};
}

test('teletype bounds edit volume, persists auto mode, and ignores edited listener messages', async t => {
  const f = await fixture(t, 'teletype');
  await f.run(`.teletype ${'x'.repeat(500)}`);
  assert.ok(f.edits.length <= 81);
  await f.run('.teletype on');
  const before = f.edits.length;
  await f.host.dispatchListeners({id: 2, chatId: '7', senderId: '7', outgoing: true, text: 'hello'});
  assert.ok(f.edits.length > before);
  const after = f.edits.length;
  await f.host.dispatchListeners({id: 2, chatId: '7', senderId: '7', outgoing: true, edited: true, text: 'edited'});
  assert.equal(f.edits.length, after);
  assert.equal((await f.read('config.json')).schemaVersion, 1);
});

test('autochangename migrates settings, validates timezone, and updates profile', async t => {
  const initial = {users: {'7': {user_id: 7, timezone: 'Asia/Shanghai', original_first_name: 'Alice', original_last_name: null, is_enabled: false, mode: 'time', last_update: null, text_index: 0, marker: 'keep'}}, random_texts: ['busy'], extra: 'keep'};
  const f = await fixture(t, 'autochangename', {initial, file: 'autochangename.json'});
  assert.equal(f.host.snapshot().jobs.jobs, 1);
  await f.run('.acn tz Invalid/Zone');
  assert.match(f.edits.at(-1).text, /无效/);
  await f.run('.acn text add focused');
  await f.run('.acn text on');
  await f.run('.acn emoji on');
  await f.run('.acn order name,text,emoji,time');
  await f.run('.acn on');
  assert.equal(f.invokes.length, 1);
  const state = await f.read('autochangename.json');
  assert.equal(state.users['7'].user_id, '7');
  assert.equal(state.users['7'].marker, 'keep');
  assert.equal(state.users['7'].mode, 'both');
  assert.equal(state.users['7'].display_order, 'name,text,emoji,time');
  assert.deepEqual(state.random_texts, ['busy', 'focused']);
  assert.equal(state.extra, 'keep');
});

test('sendat registers stable jobs and enforces ownership for mutation commands', async t => {
  const f = await fixture(t, 'sendat');
  await f.run('.sendat every 5 minutes 2 times | hello');
  assert.match(f.edits.at(-1).text, /已添加任务 #1/);
  assert.equal(f.host.snapshot().jobs.jobs, 1);
  await f.run('.sendat pause 1', {chatId: '8'});
  assert.match(f.edits.at(-1).text, /只能管理自己的任务/);
  await f.run('.sendat pause 1');
  assert.equal(f.host.snapshot().jobs.jobs, 0);
  await f.run('.sendat resume 1');
  assert.equal(f.host.snapshot().jobs.jobs, 1);
  await f.run('.sendat rm 1');
  assert.equal(f.host.snapshot().jobs.jobs, 0);
  assert.equal((await f.read('tasks.json')).schemaVersion, 1);
});

test('sendat compensates an overdue one-shot task once during startup', async t => {
  const initial = {tasks: [{task_id: 9, cid: 7, msg: 'late', interval: false, cron: true, pause: false, time_limit: -1, hour: '0', minute: '0', second: '0', current_count: 0, dueAt: '2000-01-01T00:00:00.000Z'}]};
  const f = await fixture(t, 'sendat', {initial, file: 'tasks.json'});
  assert.equal(f.sends.length, 1);
  assert.equal((await f.read('tasks.json')).tasks.length, 0);
});

test('sendat does not duplicate an indeterminate prepared one-shot delivery', async t => {
  const initial = {tasks: [{task_id: 10, cid: '7', msg: 'maybe sent', interval: false, cron: true, pause: false, time_limit: -1, hour: '0', minute: '0', second: '0', current_count: 0, dueAt: '2000-01-01T00:00:00.000Z', delivery: 'prepared'}], timezone: 'Asia/Shanghai'};
  const f = await fixture(t, 'sendat', {initial, file: 'tasks.json'});
  assert.equal(f.sends.length, 0);
  assert.equal((await f.read('tasks.json')).tasks.length, 0);
});

test('acron imports legacy tasks and manages a dynamically registered send task', async t => {
  const initial = {seq: 2, tasks: [{id: 2, type: 'send', cron: '0 0 2 * * *', chat: 'me', chatId: 7, createdAt: '1', message: 'legacy', disabled: true}], unknown: 'keep'};
  const f = await fixture(t, 'acron', {initial, file: 'acron_config.json', reply: {id: 4, chatId: '7', text: 'scheduled'}});
  assert.equal(f.host.snapshot().jobs.jobs, 0);
  await f.run('.acron send 0 0 2 * * * me remark');
  assert.equal(f.host.snapshot().jobs.jobs, 1);
  await f.run('.acron ls');
  assert.match(f.edits.at(-1).text, /<code>3<\/code>/);
  await f.run('.acron disable 3');
  assert.equal(f.host.snapshot().jobs.jobs, 0);
  await f.run('.acron enable 3');
  assert.equal(f.host.snapshot().jobs.jobs, 1);
  await f.run('.acron rm 3');
  assert.equal(f.host.snapshot().jobs.jobs, 0);
  const state = await f.read('acron_config.json');
  assert.equal(state.tasks[0].id, '2');
  assert.equal(state.unknown, 'keep');
});

test('all four plugins unload without retaining jobs or listeners', async t => {
  for (const id of ['acron', 'autochangename', 'sendat', 'teletype']) {
    const f = await fixture(t, id);
    await f.host.unload(id);
    assert.equal(f.host.snapshot().plugins, 0);
    assert.equal(f.host.snapshot().jobs.jobs, 0);
  }
});
