'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'autodel', packageRoot: path.resolve(__dirname, '../autodel'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function fixture(initial = {schemaVersion: 1, settings: {}, importedLegacy: true}) {
  let state = structuredClone(initial); const edits = [], tasks = [];
  const json = {async read() {return structuredClone(state);}, async update(fn) {state = await fn(structuredClone(state)); return structuredClone(state);}};
  const context = {signal: new AbortController().signal, storage: {json() {return json;}, sqlite() {return {read() {throw Object.assign(new Error('missing'), {code: 'ENOENT'});}};}},
    telegram: {async edit(_m, text) {edits.push(text);}, async withClient() {throw new Error('unexpected');}},
    tasks: {run(label, fn) {tasks.push({label, fn}); return Promise.resolve();}}, log: {info() {}, error() {}}};
  const plugin = create(), message = {id: 1, chatId: '-1009007199254740993', senderId: '9', outgoing: true, text: ''};
  return {plugin, context, edits, tasks, state: () => state,
    run: text => plugin.commands.autodel.handle({command: 'autodel', prefix: '.', args: text.trim().split(/\s+/).filter(Boolean), message: {...message, text: `.autodel ${text}`}}, context),
    listen: patch => plugin.listeners[0].handle({...message, id: 2, text: 'hello', ...patch}, context)};
}

test('sets, lists and cancels chat/global durations with precise string ids', async () => {
  const f = fixture();
  await f.run('5 分钟 global');
  assert.equal(f.state().settings['0'], 300);
  await f.run('l');
  assert.match(f.edits.at(-1), /全局 300 秒/);
  await f.run('cancel global');
  assert.equal(f.state().settings['0'], undefined);
  await f.run('4s');
  assert.match(f.edits.at(-1), /不能少于5秒/);
});

test('only schedules outgoing non-command messages and ignores edits through host metadata', async () => {
  const f = fixture({schemaVersion: 1, settings: {'-1009007199254740993': 5}, importedLegacy: true});
  await f.listen({outgoing: false});
  await f.listen({outgoing: true});
  assert.equal(f.tasks.length, 1);
  assert.match(f.tasks[0].label, /-1009007199254740993:2/);
});

test('compiled plugin loads, cancels delayed work and unloads through PluginHost', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'autodel-v2-')));
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient(op, signal) {return op({deleteMessages: async () => {}}, signal);},
  }});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  await host.load(create());
  await host.dispatchPrimary({id: 1, chatId: '7', senderId: '1', outgoing: true, text: '.autodel 5s'});
  await host.dispatchListeners({id: 2, chatId: '7', senderId: '1', outgoing: true, text: 'temporary'});
  const report = await host.unload('autodel', 1000);
  assert.equal(report.completed, true);
  assert.equal(report.pendingTasks, 0);
});
