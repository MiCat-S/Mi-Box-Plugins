'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const Database = require(path.join(core, 'node_modules/better-sqlite3'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'keyword', packageRoot: path.resolve(__dirname, '../keyword'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

const task = (id, chatId, key, response, extra = {}) => ({id, chatId, key, response, include: true, regexp: false,
  exact: false, caseSensitive: false, ignoreForward: false, reply: true, deleteSource: false,
  banSeconds: 0, restrictSeconds: 0, deleteReplyAfter: 0, deleteSourceAfter: 0, ...extra});

async function fixture(t, {state, prepare, client: patch = {}, onEdit, onReply} = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'mibot-keyword-v2-')));
  const dir = path.join(root, 'keyword');
  await fsp.mkdir(dir);
  if (state) await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify(state));
  await prepare?.(root, dir);
  const edits = [], replies = [], sent = [], deleted = [], logs = [];
  const client = {async sendMessage(peer, options) {sent.push({peer, options}); return {id: 100 + sent.length};},
    async deleteMessages(peer, ids, options) {deleted.push({peer, ids, options});},
    async getInputEntity(value) {return value;}, async invoke() {}, ...patch};
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error(event, fields) {logs.push({event, fields});}}, telegram: {
    async edit(message, text, options) {await onEdit?.(message, text); edits.push({message, text, options});},
    async reply(message, text, options) {await onReply?.(message, text); replies.push({message, text, options});},
    async invoke() {}, async getReply() {}, async withClient(operation, signal) {return operation(client, signal);},
  }});
  await host.load(create());
  t.after(async () => {await host.shutdown(1000); await fsp.rm(root, {recursive: true, force: true});});
  return {root, host, edits, replies, sent, deleted, logs,
    read: async () => JSON.parse(await fsp.readFile(path.join(dir, 'config.json'), 'utf8')),
    run: (text, extra = {}) => host.dispatchPrimary({id: 1, chatId: '-1001', senderId: '9', outgoing: true, text, ...extra}),
    runAt: (chatId, text) => host.dispatchPrimary({id: 1, chatId, senderId: '9', outgoing: true, text}),
    listen: (text, extra = {}) => host.dispatchListeners({id: 2, chatId: '-1001', senderId: '42', outgoing: false,
      text, raw: {peerId: '-1001', sender: {firstName: '<Alice>'}}, ...extra}),
  };
}

test('keyword command matrix persists additions, aliases, lists and removals', async t => {
  const f = await fixture(t);
  await f.run('.keyword hello\n+++\nwelcome\n+++\nexact case ignore_forward\n+++\nreply');
  assert.match(f.edits.at(-1).text, /ID 为 <code>1<\/code>/);
  await f.run('.keyword alias -1009');
  assert.equal((await f.read()).aliases['-1001'], '-1009');
  await f.run('.keyword list');
  assert.match(f.edits.at(-1).text, /hello/);
  await f.run('.keyword rm 1');
  assert.match(f.edits.at(-1).text, /已删除 <code>1<\/code>/);
  assert.equal((await f.read()).tasks.length, 0);
  await f.run('.keyword alias rm');
  assert.equal((await f.read()).aliases['-1001'], undefined);
});

test('keyword allocates distinct persistent IDs for concurrent additions in different chats', async t => {
  const f = await fixture(t);
  await Promise.all([
    f.runAt('-1001', '.keyword one\n+++\nreply one'),
    f.runAt('-1002', '.keyword two\n+++\nreply two'),
  ]);
  const saved = await f.read();
  assert.deepEqual(saved.tasks.map(item => item.id).sort((a, b) => a - b), [1, 2]);
  assert.equal(saved.nextId, 3);
});

test('keyword preserves exact, case, forwarded, outgoing and inherited trigger rules', async t => {
  const state = {schemaVersion: 1, nextId: 3, importedLegacy: true, aliases: {'-1001': '-1009'}, tasks: [
    task(1, '-1009', 'Exact', 'inherited', {include: false, exact: true, caseSensitive: true, ignoreForward: true}),
    task(2, '-1001', 'hello', 'local'),
  ]};
  const f = await fixture(t, {state});
  await f.listen('HELLO there');
  assert.deepEqual(f.sent.map(item => item.options.message), ['local']);
  await f.listen('Exact', {forwarded: true, id: 3});
  assert.deepEqual(f.sent.map(item => item.options.message), ['local']);
  await f.listen('Exact', {id: 4});
  assert.deepEqual(f.sent.map(item => item.options.message), ['local', 'inherited']);
  await f.listen('hello', {outgoing: true, id: 5});
  await f.listen('hello', {edited: true, id: 6});
  assert.deepEqual(f.sent.map(item => item.options.message), ['local', 'inherited']);
});

test('keyword help is complete and unknown command failures use fixed logs and output', async t => {
  let calls = 0;
  const f = await fixture(t, {onEdit: async () => {
    if (++calls === 2) throw Object.assign(new Error('SECRET_MESSAGE'), {name: 'SECRET_NAME', code: 'SECRET_CODE'});
  }});
  await f.run('.keyword help');
  assert.match(f.edits.at(-1).text, /ignore_forward/);
  await f.run('.keyword alias -1009');
  assert.equal(f.edits.at(-1).text, '操作失败，请稍后重试');
  assert.deepEqual(f.logs.at(-1), {event: 'keyword_command_failed', fields: {kind: 'internal'}});
  assert.doesNotMatch(JSON.stringify({edits: f.edits, logs: f.logs}), /SECRET_/);
});

test('keyword uses bounded regexp workers and continues after an unsafe input', async t => {
  const state = {schemaVersion: 1, nextId: 3, aliases: {}, importedLegacy: true, tasks: [
    task(1, '-1001', '^(a+)+$', 'unsafe', {regexp: true}), task(2, '-1001', '!', 'safe'),
  ]};
  const f = await fixture(t, {state});
  await f.listen('a'.repeat(4096) + '!');
  assert.deepEqual(f.sent.map(item => item.options.message), ['safe']);
  assert.deepEqual(f.logs, [{event: 'keyword_regexp_failed', fields: {kind: 'invalid_or_budget'}}]);
});

test('keyword unload cancels an in-flight regexp worker without sending a reply', async t => {
  const state = {schemaVersion: 1, nextId: 2, aliases: {}, importedLegacy: true,
    tasks: [task(1, '-1001', '^(a+)+$', 'must not send', {regexp: true})]};
  const f = await fixture(t, {state});
  const pending = f.listen('a'.repeat(4095) + '!');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.host.unload('keyword', 1000)).completed, true);
  await assert.rejects(pending, error => error instanceof AggregateError || error?.name === 'AbortError');
  assert.equal(f.sent.length, 0);
});

test('keyword migrates legacy sqlite rows and preserves reply placeholders', async t => {
  const f = await fixture(t, {prepare(_root, dir) {
    const db = new Database(path.join(dir, 'keyword.db'));
    db.exec('CREATE TABLE keyword_tasks (task_id INTEGER PRIMARY KEY,cid INTEGER,key TEXT,msg TEXT,include INTEGER,regexp INTEGER,exact INTEGER,case_sensitive INTEGER,ignore_forward INTEGER,reply INTEGER,delete_msg INTEGER,ban INTEGER,restrict INTEGER,delay_delete INTEGER,source_delay_delete INTEGER); CREATE TABLE keyword_alias (from_cid INTEGER PRIMARY KEY,to_cid INTEGER);');
    db.prepare('INSERT INTO keyword_tasks VALUES (1,-1001,?,?,1,0,0,0,0,1,0,0,0,0,0)').run('hello', '$mention $code_id $code_name');
    db.prepare('INSERT INTO keyword_alias VALUES (?,?)').run(-1002, -1001);
    db.close();
  }});
  const saved = await f.read();
  assert.equal(saved.tasks[0].chatId, '-1001');
  assert.equal(saved.aliases['-1002'], '-1001');
  await f.listen('hello');
  assert.match(f.sent[0].options.message, /tg:\/\/user\?id=42/);
  assert.match(f.sent[0].options.message, /<\/a> 42 &lt;Alice&gt;/);
});

test('keyword paginates complete lists and logs delayed-delete failures without exception details', async t => {
  const tasks = Array.from({length: 90}, (_, i) => task(i + 1, '-1001', `key-${i}`, `&${i}`.repeat(35), i === 0 ? {deleteSource: true} : {}));
  const secret = Object.assign(new Error('SECRET_DELETE_MESSAGE'), {name: 'SECRET_ERROR_NAME'});
  const f = await fixture(t, {state: {schemaVersion: 1, nextId: 91, aliases: {}, importedLegacy: true, tasks},
    client: {async deleteMessages() {throw secret;}}});
  await f.run('.keyword list');
  const pages = [f.edits.at(-1).text, ...f.replies.map(item => item.text)];
  assert.ok(pages.length > 1 && pages.every(page => page.length <= 3500));
  for (let i = 0; i < 90; i++) assert.match(pages.join('\n'), new RegExp(`key-${i}(?:<|&lt;)`));
  await f.listen('key-0');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.logs.some(item => item.event === 'keyword_delete_source_failed' && item.fields.kind === 'internal'));
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET_/);
});

test('keyword parses the multiline task body from raw.message and keeps bare moderation actions disabled', async t => {
  let invokes = 0;
  const f = await fixture(t, {client: {async invoke() {invokes++;}}});
  const original = '.keyword naked\n+++\nraw reply\n+++\ninclude\n+++\nreply ban restrict ban0';
  await f.run('.keyword naked +++ raw reply', {raw: {message: original, peerId: '-1001'}});
  const saved = await f.read();
  assert.equal(saved.tasks[0].key, 'naked');
  assert.equal(saved.tasks[0].response, 'raw reply');
  assert.equal(saved.tasks[0].banSeconds, 0);
  assert.equal(saved.tasks[0].restrictSeconds, 0);
  await f.listen('naked');
  assert.equal(f.sent.at(-1).options.message, 'raw reply');
  assert.equal(invokes, 0, 'the original plugin never treats bare ban/restrict as permanent moderation');
});

test('keyword cancellation after send settlement starts no moderation or deletion', async t => {
  let entered, release, entityCalls = 0, invokes = 0, deletes = 0;
  const ready = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const state = {schemaVersion: 1, nextId: 2, aliases: {}, importedLegacy: true,
    tasks: [task(1, '-1001', 'hit', 'reply', {banSeconds: 300, deleteSource: true, deleteReplyAfter: 1})]};
  const f = await fixture(t, {state, client: {
    async sendMessage() {entered(); await gate; return {id: 101};},
    async getInputEntity(value) {entityCalls++; return value;}, async invoke() {invokes++;},
    async deleteMessages() {deletes++;},
  }});
  const pending = f.listen('hit');
  await ready;
  const unloading = f.host.unload('keyword', 1000);
  release();
  assert.equal((await unloading).completed, true);
  await assert.rejects(pending, error => error instanceof AggregateError || error?.name === 'AbortError');
  assert.deepEqual({entityCalls, invokes, deletes}, {entityCalls: 0, invokes: 0, deletes: 0});
});

test('keyword cancellation after the first moderation entity starts no later RPC or deletion', async t => {
  let entered, release, entityCalls = 0, invokes = 0, deletes = 0;
  const ready = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const state = {schemaVersion: 1, nextId: 2, aliases: {}, importedLegacy: true,
    tasks: [task(1, '-1001', 'hit', 'reply', {restrictSeconds: 300, deleteSource: true})]};
  const f = await fixture(t, {state, client: {
    async getInputEntity(value) {entityCalls++; if (entityCalls === 1) {entered(); await gate;} return value;},
    async invoke() {invokes++;}, async deleteMessages() {deletes++;},
  }});
  const pending = f.listen('hit');
  await ready;
  const unloading = f.host.unload('keyword', 1000);
  release();
  assert.equal((await unloading).completed, true);
  await assert.rejects(pending, error => error instanceof AggregateError || error?.name === 'AbortError');
  assert.deepEqual({entityCalls, invokes, deletes}, {entityCalls: 1, invokes: 0, deletes: 0});
});
