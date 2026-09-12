'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'clean_member', packageRoot: path.resolve(__dirname, '../clean_member'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));

function fixture(directory, broken = false) {
  const chat = {className: 'Chat', id: 77n, title: '=Injected', creator: true};
  const user = {className: 'User', id: 99n, username: '=2+3', firstName: '@SUM(1,1)', lastName: '', bot: false};
  let state = {schemaVersion: 1, entries: {}}, tail = Promise.resolve();
  const edits = [];
  const client = {async getEntity() {return chat;}, async getInputEntity(value) {return value;}, async invoke(request) {
    if (request instanceof Api.messages.GetFullChat) return {fullChat: {participants: {participants: [{className: 'ChatParticipant', userId: 99n}]}}, users: [user]};
    return {};
  }, async sendFile() {}};
  const signal = new AbortController().signal;
  const context = {signal, log: {error() {}}, files: {async dataFile(name) {return broken ? directory : path.join(directory, name);}},
    storage: {json: () => ({async read() {return structuredClone(state);}, async update(operation) {const result = tail.then(async () => {state = await operation(structuredClone(state)); return structuredClone(state);}); tail = result.then(() => undefined, () => undefined); return result;}})},
    telegram: {async edit(message, text) {edits.push(text);}, async withClient(operation) {return operation(client, signal);}}};
  return {context, edits};
}

test('clean_member keeps concurrent reports unique, private, and formula-safe', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-member-security-')); t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const f = fixture(directory), command = create().commands.clean_member;
  const invoke = id => command.handle({command: 'clean_member', prefix: '.', args: ['5', 'search'], message: {id, chatId: '77', outgoing: true, text: '.clean_member 5 search', raw: {peerId: '77'}}}, f.context);
  await Promise.all([invoke(1), invoke(2)]);
  const names = (await fs.readdir(directory)).filter(name => name.endsWith('.csv'));
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
  for (const name of names) {
    const report = await fs.readFile(path.join(directory, name), 'utf8');
    assert.match(report, /"'=Injected"/);
    assert.match(report, /"'=2\+3"/);
    assert.match(report, /"'@SUM\(1,1\)"/);
    assert.equal((await fs.stat(path.join(directory, name))).mode & 0o777, 0o600);
  }
  assert.ok(f.edits.every(text => !text.includes(directory)));
});

test('clean_member hides file-system errors from Telegram output', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-member-safe-error-')); t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const f = fixture(directory, true);
  await create().commands.clean_member.handle({command: 'clean_member', prefix: '.', args: ['5', 'search'], message: {id: 1, chatId: '77', outgoing: true, text: '.clean_member 5 search', raw: {peerId: '77'}}}, f.context);
  assert.match(f.edits.at(-1), /处理失败，请检查群组权限/);
  assert.doesNotMatch(f.edits.at(-1), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
