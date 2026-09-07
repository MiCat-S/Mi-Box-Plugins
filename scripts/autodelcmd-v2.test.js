'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'autodelcmd', packageRoot: path.resolve(__dirname, '../autodelcmd'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function fixture(initial = {enabled: false, configVersion: 1, customRules: [{command: 'ping', delay: 10}]}) {
  let state = structuredClone(initial); const edits = [], tasks = [];
  const json = {async read() {return structuredClone(state);}, async update(fn) {state = await fn(structuredClone(state)); return structuredClone(state);}};
  const client = {async getMessages() {return [{id: 11, out: true}, {id: 10, out: true}];}, async deleteMessages() {}};
  const context = {signal: new AbortController().signal, storage: {json() {return json;}}, tasks: {run(label, fn) {tasks.push({label, fn}); return Promise.resolve();}},
    commands: {parse(text) {const found = text.match(/^([.,。$!！])([a-z0-9_]+)(?:\s+(.*))?$/i); return found && {prefix: found[1], command: found[2].toLowerCase(), args: found[3]?.split(/\s+/) ?? [], text};}},
    telegram: {async edit(_m, text) {edits.push(text);}, async withClient(op) {return op(client, context.signal);}}, log: {info() {}, error() {}}};
  const plugin = create(), message = {id: 10, chatId: '9007199254740993', senderId: '1', outgoing: true, saved: true, text: ''};
  return {plugin, context, edits, tasks, state: () => state, setup: () => plugin.setup(context),
    run: text => plugin.commands.autodelcmd.handle({command: 'autodelcmd', prefix: '.', args: text.trim().split(/\s+/).filter(Boolean), message: {...message, text: `.autodelcmd ${text}`}}, context),
    listen: text => plugin.listeners[0].handle({...message, text}, context)};
}

test('migrates legacy rules idempotently and defaults to disabled', async () => {
  const f = fixture(); await f.setup(); await f.setup();
  assert.equal(f.state().schemaVersion, 2);
  assert.equal(f.state().enabled, false);
  assert.deepEqual(f.state().rules, [{id: '1', command: 'ping', delay: 10}]);
  assert.equal(f.state().configVersion, 1);
});

test('manages rules, validates conflicts, and never schedules its own control command', async () => {
  const f = fixture(); await f.setup(); await f.run('on');
  await f.run('add help 12 -r');
  assert.equal(f.state().rules.some(rule => rule.command === 'help' && rule.deleteResponse), true);
  await f.run('add help 20 -r');
  assert.match(f.edits.at(-1), /冲突/);
  await f.listen('.autodelcmd status');
  assert.equal(f.tasks.length, 0);
});

test('matches parameter rules first and persists command/response deletion before scheduling', async () => {
  const f = fixture({schemaVersion: 2, enabled: true, rules: [{id: '1', command: 'tpm', delay: 120}, {id: '2', command: 'tpm', delay: 10, parameters: ['install'], deleteResponse: true}], pending: {}});
  await f.listen('.tpm install x');
  assert.equal(Object.keys(f.state().pending).length, 2);
  assert.equal(f.tasks.length, 2);
  assert.ok(Object.values(f.state().pending).every(item => item.dueAt > Date.now()));
});

test('compiled plugin restores pending work and cancels it on unload', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'autodelcmd-v2-')));
  const dir = path.join(root, 'autodelcmd'); await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({schemaVersion: 2, enabled: true, rules: [], pending: {'7:3': {chatId: '7', messageId: 3, dueAt: Date.now() + 60_000}}}));
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient(op, signal) {return op({deleteMessages: async () => {}}, signal);}}});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  await host.load(create());
  const report = await host.unload('autodelcmd', 1000);
  assert.equal(report.completed, true);
});

test('real host parser applies a Unicode prefix and longest multi-word alias before matching', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'autodelcmd-alias-v2-')));
  const dir = path.join(root, 'autodelcmd'); await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({schemaVersion: 2, enabled: true,
    rules: [{id: '1', command: 'tpm', delay: 60, parameters: ['install']}], pending: {}}));
  const host = new PluginHost({storageRoot: root, prefixes: ['🙂'], aliases: {'please': 'tpm search', 'please clean': 'tpm install'},
    logger: {info() {}, error() {}}, telegram: {async edit() {}, async reply() {}, async invoke() {}, async getReply() {},
      async withClient(op, signal) {return op({deleteMessages: async () => {}}, signal);}}});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  await host.load(create());
  await host.dispatchListeners({id: 8, chatId: '7', senderId: '1', outgoing: true, text: '🙂please clean package'});
  const state = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.pending), ['7:8']);
  assert.ok(state.pending['7:8'].dueAt > Date.now());
  assert.equal((await host.unload('autodelcmd', 1000)).completed, true);
});
