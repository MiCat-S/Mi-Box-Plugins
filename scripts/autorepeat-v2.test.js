'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'autorepeat', packageRoot: path.resolve(__dirname, '../autorepeat'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function fixture(initial) {
  let state = structuredClone(initial ?? {schemaVersion: 1, enabledGroups: ['-7'], dailyHistory: {}, lastDay: 0, trigger: {timeWindow: 300, minUsers: 2}});
  const edits = [], sent = [], tasks = [];
  const json = {async read() {return structuredClone(state);}, async update(fn) {state = await fn(structuredClone(state)); return structuredClone(state);}};
  const client = {async sendMessage(chat, value) {sent.push({chat: String(chat), value});}, async getEntity() {return {className: 'Channel', megagroup: true, id: 7, title: '<group>'};}, async *iterDialogs() {yield {isGroup: true, id: '-7'};}, async deleteMessages() {}};
  const context = {signal: new AbortController().signal, storage: {json() {return json;}}, tasks: {run(label, fn) {tasks.push({label, fn}); return Promise.resolve();}},
    telegram: {async edit(_m, text) {edits.push(text);}, async getReply() {}, async withClient(op) {return op(client, context.signal);}}, log: {info() {}, error() {}}};
  const plugin = create(), base = {id: 1, chatId: '-7', senderId: '1', outgoing: true, text: '', raw: {sender: {className: 'User', bot: false}, date: Math.floor(Date.now() / 1000)}};
  return {plugin, context, edits, sent, tasks, state: () => state, setup: () => plugin.setup(context),
    run: text => plugin.commands.autorepeat.handle({command: 'autorepeat', prefix: '.', args: text.trim().split(/\s+/).filter(Boolean), message: {...base, text: `.autorepeat ${text}`}}, context),
    listen: patch => plugin.listeners[0].handle({...base, outgoing: false, text: 'same', ...patch}, context)};
}

test('migrates legacy lowdb shape and preserves exact large chat ids', async () => {
  const f = fixture({cache: {autorepeat_settings: [-1009007199254740993n, '-7']}, daily_history: {'-7': ['old']}, last_day_check: 2, trigger_config: {timeWindow: 12, minUsers: 3}});
  await f.setup();
  assert.deepEqual(f.state().enabledGroups, ['-1009007199254740993', '-7']);
  assert.deepEqual(f.state().trigger, {timeWindow: 12, minUsers: 3});
  assert.deepEqual(f.state().dailyHistory['-7'], ['old']);
  assert.deepEqual(f.state().cache, {autorepeat_settings: [-1009007199254740993n, '-7']});
});

test('requires distinct users, repeats once per Shanghai day, and ignores loops/edits/bots', async () => {
  const f = fixture(); await f.setup();
  await f.listen({senderId: '1'}); await f.listen({senderId: '1'}); assert.equal(f.sent.length, 0);
  await f.listen({senderId: '2'}); assert.equal(f.sent.length, 1);
  await f.listen({senderId: '3'}); assert.equal(f.sent.length, 1);
  await f.listen({outgoing: true, senderId: '4'});
  await f.listen({senderId: '5', raw: {sender: {className: 'User', bot: true}}});
  assert.equal(f.sent.length, 1);
  assert.equal(f.state().dailyHistory['-7'].length, 1);
});

test('configuration validates bounds and group toggles are idempotent', async () => {
  const f = fixture(); await f.setup();
  await f.run('set 0 1'); assert.match(f.edits.at(-1), /参数错误/);
  await f.run('off'); await f.run('off'); assert.deepEqual(f.state().enabledGroups, []);
  await f.run('on'); await f.run('on'); assert.deepEqual(f.state().enabledGroups, ['-7']);
  await f.run('alloff'); assert.deepEqual(f.state().enabledGroups, []);
});

test('compiled listener metadata filters edited messages and unloads cleanly', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'autorepeat-v2-')));
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient(op, signal) {return op({deleteMessages: async () => {}}, signal);}}});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  await host.load(create());
  await host.dispatchListeners({id: 1, chatId: '-7', senderId: '1', outgoing: false, edited: true, text: 'same', raw: {sender: {className: 'User', bot: false}}});
  const report = await host.unload('autorepeat', 1000);
  assert.equal(report.completed, true);
});
