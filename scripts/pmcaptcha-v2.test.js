'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'pmcaptcha', packageRoot: path.resolve(__dirname, '../pmcaptcha'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const Utils = require(path.join(core, 'node_modules/teleproto/Utils.js'));

test('pmcaptcha keeps exact user IDs and uses the resolved high-level notification helper', async () => {
  const userId = '90071992547409931234';
  const input = new Api.InputPeerUser({userId: BigInt(userId), accessHash: 123n});
  const notifications = [], requests = [];
  let data = {schemaVersion: 1, importedLegacy: true, sessions: {}, config: {enabled: true, captchaEnabled: false, mode: 'math', timeout: 30,
    maxTries: 3, keyword: '我同意', prompt: '', failActions: [], passActions: [], whitelist: [], verified: [], failed: [], initiative: true,
    historyCount: -1, groupsInCommon: -1, wlWords: [], blWords: [], premium: 'none'}};
  const signal = new AbortController().signal;
  const client = {async getInputEntity(value) {assert.equal(value.toString(), userId); return input;}, async invoke(request) {requests.push(request); return {};},
    async updateNotifySettings(peer, options) {notifications.push({peer, options}); return true;}};
  const context = {signal, log: {error() {}}, storage: {json: () => ({async read() {return structuredClone(data);}, async update(fn) {data = await fn(structuredClone(data)); return data;}})},
    telegram: {async edit() {}, async reply() {}, async withClient(operation) {return operation(client, signal);}}, tasks: {run(_label, operation) {return operation(signal);}}};
  await create().listeners[0].handle({id: 1, chatId: userId, senderId: userId, text: 'hello', outgoing: false,
    raw: {sender: {id: BigInt(userId), firstName: 'User'}}}, context);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].peer.userId.toString(), userId);
  assert.deepEqual(notifications[0].options, {muteUntil: 2147483647, silent: true, showPreviews: true});
  const request = requests.find(value => value instanceof Api.folders.EditPeerFolders);
  assert.ok(request);
  await request.resolve(client, Utils);
  assert.equal(request.folderPeers[0].peer.userId.toString(), userId);
  assert.ok(request.getBytes().length > 0);
});

test('pmcaptcha rejects numeric bounds and retains exact-case initiative compatibility', async () => {
  let data = {schemaVersion: 1, importedLegacy: true, sessions: {}, config: {enabled: true, captchaEnabled: false, mode: 'math', timeout: 30,
    maxTries: 3, keyword: '我同意', prompt: '', failActions: [], passActions: [], whitelist: [], verified: [], failed: [], initiative: true,
    historyCount: -1, groupsInCommon: -1, wlWords: [], blWords: [], premium: 'none'}};
  const edits = [];
  const context = {signal: new AbortController().signal, storage: {json: () => ({async read() {return structuredClone(data);},
    async update(fn) {data = await fn(structuredClone(data)); return data;}})}, telegram: {async edit(_message, text) {edits.push(text);}}};
  const plugin = create();
  const message = {id: 1, chatId: '1', text: '.pmc', outgoing: true};
  await plugin.commands.pmc.subcommands.set.subcommands.time.handle({command: 'pmc', prefix: '.', args: ['3601'], message}, context);
  await plugin.commands.pmc.subcommands.set.subcommands.tries.handle({command: 'pmc', prefix: '.', args: ['1.5'], message}, context);
  await plugin.commands.pmc.subcommands.set.subcommands.initiative.handle({command: 'pmc', prefix: '.', args: ['ON'], message}, context);
  assert.equal(data.config.timeout, 30);
  assert.equal(data.config.maxTries, 3);
  assert.equal(data.config.initiative, false);
  assert.equal(edits.filter(value => value.includes('操作失败')).length, 2);
});

test('pmcaptcha cleanup cancels recovered deadlines without marking sessions failed', async () => {
  const userId = '90071992547409931234';
  let data = {schemaVersion: 1, importedLegacy: true, sessions: {[userId]: {userId, answer: '2', question: '1+1', tries: 0,
    deadline: Date.now() + 30_000, mode: 'math', promptIds: [7], createdAt: Date.now()}}, config: {enabled: true, captchaEnabled: true,
    mode: 'math', timeout: 30, maxTries: 3, keyword: '我同意', prompt: '', failActions: [], passActions: [], whitelist: [], verified: [],
    failed: [], initiative: true, historyCount: -1, groupsInCommon: -1, wlWords: [], blWords: [], premium: 'none'}};
  const pending = [], labels = [], errors = [];
  const context = {signal: new AbortController().signal, log: {error(event) {errors.push(event);}},
    storage: {json: () => ({async read() {return structuredClone(data);}, async update(fn) {data = await fn(structuredClone(data)); return data;}})},
    tasks: {run(label, operation) {labels.push(label); const promise = Promise.resolve().then(() => operation(new AbortController().signal)); pending.push(promise); return promise;}},
    telegram: {async withClient() {throw new Error('deadline must be cancelled before Telegram access');}}};
  const plugin = create();
  await plugin.setup(context);
  assert.equal(labels.length, 1);
  await plugin.cleanup();
  await Promise.allSettled(pending);
  assert.ok(data.sessions[userId]);
  assert.equal(data.config.failed.length, 0);
  assert.deepEqual(errors, []);
});

test('pmcaptcha normalizes corrupt persisted collections and paginates records', async () => {
  const failed = Array.from({length: 80}, (_, index) => ({id: String(1000 + index), name: `User-${index}-` + 'x'.repeat(80), time: 'now', reason: 'timeout'}));
  let data = {schemaVersion: 1, importedLegacy: true, sessions: [], config: {enabled: 'yes', captchaEnabled: 1, initiative: null,
    mode: 'unknown', premium: 'invalid', timeout: 99999, maxTries: -1, failActions: {}, passActions: 'bad', whitelist: ['123', 'bad'],
    verified: [], failed, wlWords: [], blWords: []}};
  const edits = [], replies = [];
  const context = {signal: new AbortController().signal, log: {error() {}}, storage: {json: () => ({async read() {return structuredClone(data);},
    async update(fn) {data = await fn(structuredClone(data)); return data;}})}, tasks: {run() {throw new Error('no task expected');}},
    telegram: {async edit(_message, text) {edits.push(text);}, async reply(_message, text) {replies.push(text);}}};
  const plugin = create();
  await plugin.setup(context);
  await plugin.commands.pmc.subcommands.record.subcommands.failed.handle({command: 'pmc', prefix: '.', args: [],
    message: {id: 1, chatId: '1', text: '.pmc record failed', outgoing: true}}, context);
  assert.equal(data.config.enabled, true);
  assert.equal(data.config.captchaEnabled, false);
  assert.deepEqual(data.config.whitelist, ['123']);
  assert.ok(replies.length > 0);
  assert.ok([edits[0], ...replies].every(value => value.length <= 3500));
});
