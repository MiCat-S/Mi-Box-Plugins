'use strict';
// Behavioral compatibility tests for the autodel V2 parity fixes against autodel/autodel.ts:
//   1) `.autodel l` must keep the original `📋 自动删除设置：` report header.
//   2) The original stored every "chat" scope under the literal "[object Object]" key
//      (msg.peerId.toString()), so that row was a second global that outranked "0".
//      The one-time import must map it onto the V2 global key with that precedence and
//      must never clobber newer V2 settings.
//   3) The original resolved the account with getMe and only deleted messages attributed
//      to it; channel posts / group send-as messages must not be scheduled.
// Tests use the real factory, the real PluginHost, real legacy SQLite and a simulated
// Telegram client. No real Telegram action is performed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const timers = require('node:timers/promises');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {messageEnvelope} = require(path.join(core, 'dist/v2/telegram.js'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const {returnBigInt} = require(path.join(core, 'node_modules/teleproto/Helpers.js'));
const Database = require(path.join(core, 'node_modules/better-sqlite3'));
const {artifactDir} = buildPlugin({id: 'autodel', packageRoot: path.resolve(__dirname, '../autodel'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

const CHAT = '-1009007199254740993';

// Direct factory harness: fast command/listener assertions without the Host.
function fixture(initial = {schemaVersion: 1, settings: {}, importedLegacy: true}) {
  let state = structuredClone(initial); const edits = [], tasks = [];
  const json = {async read() {return structuredClone(state);},
    async update(fn) {state = await fn(structuredClone(state)); return structuredClone(state);}};
  const context = {signal: new AbortController().signal,
    storage: {json() {return json;}, sqlite() {return {read() {throw Object.assign(new Error('missing'), {code: 'ENOENT'});}};}},
    telegram: {async edit(_m, text, options) {edits.push({text, options});},
      async withClient(operation) {return operation({async getMe() {return {id: 9n};}});}},
    tasks: {run(label, fn) {tasks.push({label, fn}); return Promise.resolve();}}, log: {info() {}, error() {}}};
  const plugin = create(), message = {id: 1, chatId: CHAT, senderId: '9', outgoing: true, text: ''};
  return {plugin, context, edits, tasks, state: () => state,
    run: text => plugin.commands.autodel.handle({command: 'autodel', prefix: '.',
      args: text.trim().split(/\s+/).filter(Boolean), message: {...message, text: `.autodel ${text}`}}, context),
    listen: patch => plugin.listeners[0].handle({...message, id: 2, text: 'hello', ...patch}, context)};
}

// Real Host + seeded config.json; returns the captured delete calls and a controllable clock.
async function hostFixture(t, {settings = {}, legacy = null, prefixes, selfId = '9', deleteError, logs, getMe} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'autodel-compat-')));
  t.after(async () => {await fs.rm(root, {recursive: true, force: true});});
  await fs.mkdir(path.join(root, 'autodel'), {recursive: true});
  if (settings) await fs.writeFile(path.join(root, 'autodel/config.json'),
    JSON.stringify({schemaVersion: 1, settings, importedLegacy: false}));
  if (legacy) {
    const db = new Database(path.join(root, 'autodel/autodel.db'));
    db.exec('CREATE TABLE autodel_settings (chat_id TEXT PRIMARY KEY, seconds INTEGER NOT NULL)');
    const insert = db.prepare('INSERT INTO autodel_settings (chat_id, seconds) VALUES (?, ?)');
    for (const [chat, seconds] of legacy) insert.run(chat, seconds);
    db.close();
  }
  const deletes = [];
  const captured = logs ?? [];
  const host = new PluginHost({storageRoot: root, ...(prefixes ? {prefixes} : {}),
    logger: {info() {}, error(event, fields) {captured.push({event, fields});}},
    telegram: {async edit() {}, async reply() {}, async invoke() {}, async getReply() {},
      async withClient(operation, signal) {return operation({
        async getMe() {return getMe ? getMe() : {id: BigInt(selfId)};},
        async deleteMessages(peer, ids, options) {
          if (deleteError !== undefined) throw new Error(deleteError);
          deletes.push({peer: String(peer), ids, options});
        }}, signal);}}});
  await host.load(create());
  return {root, host, deletes, logs: captured,
    config: async () => JSON.parse(await fs.readFile(path.join(root, 'autodel/config.json'), 'utf8'))};
}

// Deterministic, abortable clock probe: every sleep settles on a microtask.
function probeClock(t) {
  const waits = [];
  t.mock.method(timers, 'setTimeout', (delay, _value, options = {}) => {
    waits.push(delay);
    const signal = options?.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {reject(signal.reason); return;}
      signal?.addEventListener('abort', () => reject(signal.reason), {once: true});
      resolve();
    });
  });
  return waits;
}
const flush = async (turns = 6) => {for (let index = 0; index < turns; index++) await new Promise(setImmediate);};

test('AUTODEL-01 list keeps the original report header and HTML mode', async () => {
  const f = fixture({schemaVersion: 1, settings: {[CHAT]: 30, '0': 60}, importedLegacy: true});
  await f.run('l');
  assert.match(f.edits.at(-1).text, /📋 <b>自动删除设置：<\/b>/);
  assert.match(f.edits.at(-1).text, /当前聊天：30 秒/);
  assert.match(f.edits.at(-1).text, /全局设置：60 秒/);
  assert.equal(f.edits.at(-1).options?.parseMode, 'html');
  const empty = fixture({schemaVersion: 1, settings: {'0': 60}, importedLegacy: true});
  await empty.run('l');
  assert.match(empty.edits.at(-1).text, /当前聊天：全局 60 秒/);
  const none = fixture({schemaVersion: 1, settings: {}, importedLegacy: true});
  await none.run('l');
  assert.match(none.edits.at(-1).text, /当前聊天：未设置/);
  assert.match(none.edits.at(-1).text, /全局设置：未设置/);
});

test('AUTODEL-02 the legacy shared [object Object] row becomes the effective global with precedence', async t => {
  const f = await hostFixture(t, {settings: null, legacy: [['[object Object]', 300], ['0', 30]]});
  const config = await f.config();
  assert.equal(config.settings['0'], 300, 'the shared legacy scope outranked the "0" row');
  assert.equal(config.settings['[object Object]'], undefined, 'the dead literal key is not kept');
  assert.equal(config.importedLegacy, true);
});

test('AUTODEL-02 a shared-only legacy row still enables deletion for every chat', async t => {
  const f = await hostFixture(t, {settings: null, legacy: [['[object Object]', 45]]});
  assert.equal((await f.config()).settings['0'], 45);
});

test('AUTODEL-02 the migrated shared value actually drives deletion', async t => {
  const waits = probeClock(t);
  const f = await hostFixture(t, {settings: null, legacy: [['[object Object]', 45]]});
  await f.host.dispatchListeners({id: 41, chatId: CHAT, senderId: '9', outgoing: true, text: 'plain'});
  await flush();
  assert.deepEqual(waits, [45_000], 'the migrated shared seconds are applied to the deletion');
  assert.deepEqual(f.deletes, [{peer: CHAT, ids: [41], options: {revoke: false}}]);
});

test('AUTODEL-02 the legacy import never overwrites newer V2 settings', async t => {
  const f = await hostFixture(t, {settings: {[CHAT]: 77, '0': 99}, legacy: [['[object Object]', 300], ['0', 30]]});
  const config = await f.config();
  assert.equal(config.settings[CHAT], 77, 'an explicit V2 chat value wins');
  assert.equal(config.settings['0'], 99, 'an explicit V2 global value wins');
});

test('AUTODEL-02 imports real per-chat legacy rows and ignores unsafe values', async t => {
  const f = await hostFixture(t, {settings: null, legacy: [['-1007', 42], ['-2008', 3],
    ['-3009', 9007199254740993], ['-4009', 9007199254741]]});
  const config = await f.config();
  assert.equal(config.settings['-1007'], 42);
  assert.equal(config.settings['-2008'], undefined, 'below the original 5s floor is not imported');
  assert.equal(config.settings['-3009'], undefined, 'unsafe oversize values are not imported');
  assert.equal(config.settings['-4009'], undefined, 'millisecond overflow must match parseDuration limits');
});

test('AUTODEL-03 channel-attributed posts are never scheduled, user messages are', async t => {
  const waits = probeClock(t);
  const f = await hostFixture(t, {settings: {[CHAT]: 0.02}});
  const channel = new Api.PeerChannel({channelId: returnBigInt('9007199254740993')});
  const self = new Api.PeerUser({userId: returnBigInt('9')});
  // Outgoing channel post: attributed to the channel, not the operator.
  const post = messageEnvelope(new Api.Message({id: 11, peerId: channel, out: true, post: true,
    fromId: channel, message: 'channel post'}), {selfId: '9'});
  assert.equal(post.senderId, CHAT);
  await f.host.dispatchListeners(post);
  await flush();
  assert.deepEqual(waits, [], 'a channel post must not schedule a deletion');
  assert.deepEqual(f.deletes, []);
  // A normal outgoing message from the account in the same supergroup is still deleted.
  const mine = messageEnvelope(new Api.Message({id: 12, peerId: channel, out: true,
    fromId: self, message: 'temporary'}), {selfId: '9'});
  assert.equal(mine.senderId, '9');
  await f.host.dispatchListeners(mine);
  await flush();
  assert.deepEqual(f.deletes, [{peer: CHAT, ids: [12], options: {revoke: false}}]);
});

test('AUTODEL-04 parses every original time unit and rejects invalid ones', async () => {
  const cases = [['30s', 30], ['30 second', 30], ['30 seconds', 30], ['30sec', 30], ['30secs', 30],
    ['5m', 300], ['5 min', 300], ['5 mins', 300], ['5 minute', 300], ['5 minutes', 300],
    ['2h', 7200], ['2 hr', 7200], ['2 hrs', 7200], ['2 hour', 7200], ['2 hours', 7200],
    ['1d', 86400], ['1 day', 86400], ['1 days', 86400], ['30秒', 30], ['5分', 300], ['5分钟', 300],
    ['2小时', 7200], ['2时', 7200], ['1天', 86400], ['5 分钟', 300], ['5 minutes', 300]];
  for (const [input, expected] of cases) {
    const f = fixture();
    await f.run(input);
    assert.equal(f.state().settings[CHAT], expected, `${input} -> ${expected}s`);
  }
  for (const input of ['5', 'abc', '-5s', '1.5h', '9007199254740991d', '']) {
    const f = fixture();
    await f.run(input);
    assert.equal(f.state().settings[CHAT], undefined, `${input || '(empty)'} must not set a value`);
    assert.match(f.edits.at(-1).text, /时间格式错误|定时删除消息|设置自动删除/, `${input || '(empty)'} reports help or error`);
  }
});

test('AUTODEL-04 enforces the original 5s floor without side effects', async () => {
  const f = fixture();
  await f.run('4s');
  assert.equal(f.state().settings[CHAT], undefined);
  assert.match(f.edits.at(-1).text, /不能少于5秒/);
  await f.run('5s');
  assert.equal(f.state().settings[CHAT], 5);
});

test('AUTODEL-05 settings are per chat and global with immediate set/cancel/list effect', async () => {
  const f = fixture({schemaVersion: 1, settings: {}, importedLegacy: true});
  await f.run('5m');
  assert.equal(f.state().settings[CHAT], 300);
  assert.equal(f.state().settings['0'], undefined);
  await f.run('30s global');
  assert.equal(f.state().settings['0'], 30);
  await f.run('l');
  assert.match(f.edits.at(-1).text, /当前聊天：300 秒/);
  await f.run('cancel');
  assert.equal(f.state().settings[CHAT], undefined);
  assert.equal(f.state().settings['0'], 30, 'cancelling a chat keeps the global value');
  await f.run('cancel');
  assert.match(f.edits.at(-1).text, /未开启自动删除/);
  await f.run('cancel global');
  assert.equal(f.state().settings['0'], undefined);
  await f.run('help');
  assert.match(f.edits.at(-1).text, /定时删除消息/);
});

test('AUTODEL-06 the listener only schedules own, plain, unedited messages', async () => {
  const f = fixture({schemaVersion: 1, settings: {[CHAT]: 0.05}, importedLegacy: true});
  await f.listen({outgoing: false});
  await f.listen({outgoing: true, text: ''});
  assert.equal(f.tasks.length, 0);
  await f.listen();
  assert.equal(f.tasks.length, 1);
  assert.equal(f.tasks[0].label, `autodel:${CHAT}:2`);
});

test('AUTODEL-06 command messages never schedule their own deletion', async t => {
  const f = await hostFixture(t, {settings: {[CHAT]: 0.02}});
  await f.host.dispatchListeners({id: 21, chatId: CHAT, senderId: '9', outgoing: true, text: '.autodel 5s'});
  await f.host.dispatchListeners({id: 22, chatId: CHAT, senderId: '9', outgoing: true, text: ','});
  await flush();
  assert.deepEqual(f.deletes, []);
});

test('AUTODEL-06 deletes exactly one message with the marked peer and revoke false', async t => {
  const waits = probeClock(t);
  const f = await hostFixture(t, {settings: {[CHAT]: 0.02}});
  await f.host.dispatchListeners({id: 9007199254740991, chatId: CHAT, senderId: '9', outgoing: true, text: 'plain'});
  await flush();
  assert.equal(waits.length, 1);
  assert.deepEqual(f.deletes, [{peer: CHAT, ids: [9007199254740991], options: {revoke: false}}]);
});

test('AUTODEL-06 unloading cancels a pending deletion without touching Telegram', async t => {
  let segments = 0;
  t.mock.method(timers, 'setTimeout', async (_delay, _value, options = {}) => {
    if (++segments === 1) return;
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}));
  });
  const f = await hostFixture(t, {settings: {[CHAT]: 30 * 86400}});
  await f.host.dispatchListeners({id: 31, chatId: CHAT, senderId: '9', outgoing: true, text: 'plain'});
  await flush();
  assert.equal(segments, 2, 'a 30-day delay is served in bounded segments');
  const report = await f.host.unload('autodel', 2000);
  assert.equal(report.completed, true);
  assert.equal(report.pendingTasks, 0);
  assert.deepEqual(f.deletes, []);
});

test('AUTODEL-07 deletes only messages authored by the exact cached account id', async t => {
  probeClock(t);
  const selfId = '9007199254740993';
  const f = await hostFixture(t, {settings: {[CHAT]: 5}, selfId});
  const channel = new Api.PeerChannel({channelId: returnBigInt('9007199254740993')});
  const myself = new Api.PeerUser({userId: returnBigInt(selfId)});
  const other = new Api.PeerUser({userId: returnBigInt('42')});
  const sendAs = new Api.PeerChannel({channelId: returnBigInt('1001234567890')});
  const send = message => f.host.dispatchListeners(message);
  await send(messageEnvelope(new Api.Message({id: 51, peerId: channel, out: true, fromId: myself, message: 'mine'}), {selfId}));
  // An own forward keeps fromId = the forwarder, so it is still deleted.
  await send(messageEnvelope(new Api.Message({id: 52, peerId: channel, out: true, fromId: myself,
    fwdFrom: {className: 'MessageFwdHeader', date: 1, fromId: myself}, message: 'own forward'}), {selfId}));
  await send(messageEnvelope(new Api.Message({id: 53, peerId: channel, out: true, fromId: other, message: 'other'}), {selfId}));
  await send(messageEnvelope(new Api.Message({id: 54, peerId: channel, out: true, fromId: sendAs, message: 'send-as'}), {selfId}));
  await send({id: 55, chatId: CHAT, senderId: undefined, outgoing: true, text: 'missing sender'});
  await flush();
  assert.deepEqual(f.deletes, [
    {peer: CHAT, ids: [51], options: {revoke: false}},
    {peer: CHAT, ids: [52], options: {revoke: false}},
  ], 'only the exact account id passes, with full big-id precision');
});

test('AUTODEL-07 a failed account lookup schedules nothing and is retried later', async t => {
  probeClock(t);
  let calls = 0;
  const f = await hostFixture(t, {settings: {[CHAT]: 5},
    getMe() {calls++; if (calls === 1) throw new Error('TEMP'); return {id: 9n};}});
  await f.host.dispatchListeners({id: 56, chatId: CHAT, senderId: '9', outgoing: true, text: 'plain'});
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(f.deletes, [], 'a failed account lookup must not schedule a deletion');
  await f.host.dispatchListeners({id: 57, chatId: CHAT, senderId: '9', outgoing: true, text: 'plain'});
  await flush();
  assert.equal(calls, 2, 'the failure is not cached; the lookup is retried');
  assert.deepEqual(f.deletes, [{peer: CHAT, ids: [57], options: {revoke: false}}]);
});

test('AUTODEL-08 deletion failures log a fixed event without the raw error text', async t => {
  probeClock(t);
  const secret = 'sk-live-DEADBEEF /etc/telebox/secret.db';
  const f = await hostFixture(t, {settings: {[CHAT]: 5}, deleteError: secret});
  await f.host.dispatchListeners({id: 61, chatId: CHAT, senderId: '9', outgoing: true, text: 'plain'});
  await flush(10);
  assert.deepEqual(f.deletes, []);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].event, 'autodel:delete_failed');
  assert.deepEqual(f.logs[0].fields, {chatId: CHAT, messageId: 61});
  assert.equal(JSON.stringify(f.logs[0]).includes('sk-live'), false, 'credentials must not reach the log');
  assert.equal(JSON.stringify(f.logs[0]).includes('/etc/telebox'), false, 'paths must not reach the log');
});
