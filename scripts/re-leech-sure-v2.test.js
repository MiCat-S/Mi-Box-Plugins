'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {createHelp} = require(path.join(core, 'dist/v2/builtins/help.js'));
const {renderCommandHelp} = require(path.join(core, 'dist/v2/commands.js'));
const {HTMLParser} = require(path.join(core, 'node_modules/teleproto/extensions/html.js'));
const Database = require(path.join(core, 'node_modules/better-sqlite3'));
const factories = new Map();
function create(id) {
  if (!factories.has(id)) {
    const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, '..', id), entry: 'v2.ts'});
    factories.set(id, require(path.join(artifactDir, 'index.cjs')).default);
  }
  return factories.get(id)();
}
async function fixture(t, id, {client = {}, reply} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibox-extensions-')));
  const edits = [], errors = [];
  const host = new PluginHost({storageRoot: root, prefixes: ['!'], logger: {info() {}, error(...args) {errors.push(args);}},
    telegram: {
      async edit(_message, text) {edits.push(text);}, async reply(_message, text) {edits.push(text);},
      async invoke() {assert.fail('unexpected RPC');}, async getReply() {return reply;},
      async withClient(operation, signal) {return operation(client, signal);},
    }});
  t.after(async () => {
    assert.equal((await host.shutdown(2000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  await host.load(create(id));
  await host.load(createHelp(host));
  const send = (text, extra = {}) => host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text, ...extra});
  const visible = () => edits.map(page => HTMLParser.parse(page)[0]).join('\n');
  return {root, host, edits, errors, send, visible};
}

test('sure preserves case-sensitive rules, authorization and incoming delivery', async t => {
  const sent = [];
  const f = await fixture(t, 'sure', {client: {async getMe() {return {id: 1};}, async sendMessage(_peer, options) {sent.push(options);}}});
  const config = () => fs.readFile(path.join(f.root, 'sure/config.json'), 'utf8').then(JSON.parse);
  await f.send('!sure user add 456');
  assert.match(f.edits.at(-1), /sure user 已添加/);
  assert.deepEqual((await config()).users, ['456']);
  await f.send('!sure chat add 789');
  await f.send('!sure msg add hello world');
  assert.deepEqual((await config()).messages, {hello: 'hello'});
  const before = await config();
  for (const input of ['USER add 123', 'user ADD 123', 'msg add', 'user add abc', 'user add -10042', 'unknown add 1']) {
    await f.send(`!sure ${input}`);
    assert.match(f.edits.at(-1), /用法/);
    assert.deepEqual(await config(), before, input);
  }
  await f.send('!sure ls');
  assert.match(f.edits.at(-1), /用户：1/);
  await f.send('!sure user add 42', {senderId: '2'});
  assert.match(f.edits.at(-1), /只有 owner 可以管理 sure 白名单/);
  assert.deepEqual(await config(), before);
  const message = {id: 3, chatId: '789', senderId: '456', outgoing: false, text: 'hello', raw: {peerId: 'peer'}};
  await f.host.dispatchListeners({...message, outgoing: true});
  await f.host.dispatchListeners({...message, chatId: '42'});
  await f.host.dispatchListeners({...message, senderId: '42'});
  await f.host.dispatchListeners({...message, text: 'hello world'});
  assert.deepEqual(sent, []);
  await f.host.dispatchListeners(message);
  assert.deepEqual(sent, [{message: 'hello'}]);
  assert.equal((await f.host.unload('sure', 2000)).completed, true);
  await f.host.load(create('sure'));
  await f.host.dispatchListeners({...message, id: 4});
  assert.deepEqual(sent, [{message: 'hello'}, {message: 'hello'}]);
  assert.deepEqual(await config(), before);
  assert.deepEqual(f.errors, []);
});

test('sure nested help examples execute against the installed extension', async t => {
  const command = create('sure').commands.sure;
  const root = renderCommandHelp('sure', command, {prefix: '!'});
  for (const example of ['!sure user add 123456789', '!sure chat del 123456789', '!sure msg add hello']) assert.ok(root.includes(example));
  assert.doesNotMatch(root, /!sure user user|!sure chat chat|!sure msg msg/);
  const focused = renderCommandHelp('sure', command, {prefix: '!', path: ['user', 'add']});
  assert.match(focused, /!sure user add 123456789/);
  const f = await fixture(t, 'sure', {client: {async getMe() {return {id: 1};}}});
  await f.send('!sure user add 123456789');
  assert.match(f.edits.at(-1), /sure user 已添加/);
  await f.send('!sure msg add hello');
  assert.match(f.edits.at(-1), /sure 消息规则已添加/);
  await f.send('!sure ls');
  assert.match(f.edits.at(-1), /用户：1/);
});

test('leech serves help, session checks and existing archive statistics', async t => {
  const f = await fixture(t, 'leech', {client: {async getMe() {return {id: 99n};}}});
  await fs.mkdir(path.join(f.root, 'leech'), {recursive: true});
  const file = path.join(f.root, 'leech/leech.sqlite');
  const db = new Database(file);
  try {db.exec('CREATE TABLE messages (id INTEGER); INSERT INTO messages VALUES (1), (2)');} finally {db.close();}
  await f.send('!leech help');
  assert.match(f.visible(), /!leech session/);
  assert.match(f.visible(), /历史消息抓取及任务管理尚未实现/);
  await f.send('!leech db');
  assert.match(f.edits.at(-1), /Leech 数据库已启用/);
  await f.send('!leech session');
  assert.match(f.edits.at(-1), /Telegram 会话正常[\s\S]*99/);
  await f.send('!leech stats');
  assert.match(f.edits.at(-1), /messages: 2/);
  await f.send('!leech bogus');
  assert.match(f.edits.at(-1), /未知子命令/);
  assert.deepEqual(f.errors, []);
});

test('re forwards the selected message range and repeat count then deletes the command', async t => {
  const forwarded = [];
  let deleted = 0;
  const f = await fixture(t, 're', {
    reply: {id: 10, chatId: 'source', outgoing: false, text: 'reply', raw: {async getInputChat() {return 'source';}}},
    client: {async forwardMessages(peer, options) {forwarded.push({peer, ...options});}},
  });
  const raw = {async getInputChat() {return 'target';}, async delete() {deleted++;}};
  await f.send('!re 3 2', {replyToId: 10, raw});
  assert.deepEqual(forwarded, Array.from({length: 2}, () => ({peer: 'target', fromPeer: 'source', messages: [8, 9, 10]})));
  assert.equal(deleted, 1);
  forwarded.length = 0;
  await f.send('!re 100 100', {replyToId: 10, raw});
  assert.equal(forwarded.length, 10);
  assert.deepEqual(forwarded[0].messages, Array.from({length: 10}, (_, i) => i + 1));
  assert.equal(deleted, 2);
  assert.deepEqual(f.errors, []);
});

test('re keeps reply and forwarding failure guidance', async t => {
  const empty = await fixture(t, 're');
  await empty.send('!re');
  assert.match(empty.edits.at(-1), /请回复一条消息/);
  let deleted = false;
  const denied = await fixture(t, 're', {
    reply: {id: 10, chatId: 'source', outgoing: false, text: 'reply', raw: {async getInputChat() {return 'source';}}},
    client: {async forwardMessages() {throw new Error('restricted');}},
  });
  await denied.send('!re', {replyToId: 10, raw: {async getInputChat() {return 'target';}, async delete() {deleted = true;}}});
  assert.match(denied.edits.at(-1), /复读失败：目标消息可能禁止转发/);
  assert.equal(deleted, false);
});
