'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const {artifactDir} = buildPlugin({id: 'trace', packageRoot: path.resolve(__dirname, '../trace'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
async function fixture(t, {initial, premium = false, prefixes} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trace-v2-')));
  if (initial) {
    await fs.mkdir(path.join(root, 'trace'));
    await fs.writeFile(path.join(root, 'trace/db.json'), JSON.stringify(initial));
  }
  const edits = [], replies = [], reactions = [], deleted = [], errors = [];
  let failEdit = false;
  let failReply = false;
  let deletion;
  const deletionDone = new Promise(resolve => {deletion = resolve;});
  let reply;
  const host = new PluginHost({storageRoot: root, ...(prefixes ? {prefixes} : {}), logger: {info() {}, error(event) {errors.push(event);}}, telegram: {
    async edit(_, text) {if (failEdit) throw new Error('transport secret'); edits.push(text);},
    async reply(_, text) {if (failReply) throw new Error('reply transport secret'); replies.push(text);}, async invoke() {},
    async getReply() {return reply;},
    async withClient(operation, signal) {return operation({
      async getInputEntity() {return new Api.InputPeerSelf();},
      async invoke(request) {reactions.push(request);},
      async getMe() {return {premium};},
      async deleteMessages(...args) {deleted.push(args); deletion();},
    }, signal);},
  }});
  await host.load(create());
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  const message = {id: 1, chatId: '123', senderId: '42', outgoing: true, text: ''};
  return {edits, replies, reactions, deleted, errors, deletionDone, shutdown: () => host.shutdown(1000),
    read: async () => JSON.parse(await fs.readFile(path.join(root, 'trace/db.json'), 'utf8')),
    reply(value) {reply = value;},
    failEdits(value = true) {failEdit = value;},
    failReplies(value = true) {failReply = value;},
    run: (text, extra = {}) => host.dispatchPrimary({...message, text, ...extra}),
    listen: (text, extra = {}) => host.dispatchListeners({...message, senderId: '77', outgoing: false, text, ...extra})};
}

test('trace uses the complete rendered help for root and case-insensitive help entries', async t => {
  const f = await fixture(t, {prefixes: ['!']});
  await f.run('!trace');
  await f.run('!trace HELP extra');
  await f.run('!trace H');
  assert.equal(f.edits.length, 3);
  for (const output of f.edits) {
    assert.match(output, /自动回应插件/);
    assert.match(output, /!trace kw add/);
    assert.doesNotMatch(output, /<code>trace kw add/);
  }
});

test('trace keeps legacy case-insensitive management commands and boolean values', async t => {
  const f = await fixture(t);
  await f.run('.trace KW ADD Hello 👍');
  await f.run('.trace BIG FALSE');
  await f.listen('say Hello');
  assert.equal(f.reactions[0].reaction[0].emoticon, '👍');
  assert.equal(f.reactions[0].big, false);
  await f.run('.trace KW DEL Hello');
  await f.listen('say Hello');
  assert.equal(f.reactions.length, 1);
});

test('trace status preserves tracked details and paginates within Telegram limits', async t => {
  const keywords = Object.fromEntries(Array.from({length: 420}, (_, i) => [`<keyword-${i}>`, ['👍']]));
  const f = await fixture(t, {initial: {users: {'9007199254740993': ['🔥']}, keywords, config: {big: true, keepLog: true}}});
  await f.run('.trace STATUS');
  const pages = [...f.edits, ...f.replies];
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= 4096));
  assert.match(pages.join('\n'), /9007199254740993/);
  assert.match(pages.join('\n'), /&lt;keyword-419&gt;/);
  assert.match(pages.join('\n'), /🔥/);
});

test('trace does not turn a completed mutation into a business failure when its receipt fails', async t => {
  const f = await fixture(t);
  f.failEdits();
  await f.run('.trace kw add persisted 👍');
  assert.deepEqual((await f.read()).keywords.persisted, [{emoticon: '👍'}]);
  assert.deepEqual(f.errors, ['trace.receipt_failed']);
  assert.equal(f.edits.length, 0);
});

test('trace status keeps its first page when a continuation cannot be delivered', async t => {
  const keywords = Object.fromEntries(Array.from({length: 420}, (_, i) => [`keyword-${i}`, ['👍']]));
  const f = await fixture(t, {initial: {users: {}, keywords, config: {big: true, keepLog: true}}});
  f.failReplies();
  await f.run('.trace status');
  assert.equal(f.edits.length, 1);
  assert.match(f.edits[0], /Trace 追踪状态/);
  assert.deepEqual(f.errors, ['trace.status_delivery_interrupted']);
});
test('trace keyword listener preserves graphemes, config and own-message filtering', async t => {
  const f = await fixture(t);
  await f.run('.trace kw add hello ❤️‍🔥👍');
  await f.listen('hello');
  assert.deepEqual(f.reactions[0].reaction.map(r => r.emoticon), ['❤️‍🔥', '👍']);
  await f.run('.trace big false');
  await f.listen('hello');
  assert.equal(f.reactions[1].big, false);
  await f.listen('hello', {outgoing: true});
  await f.listen('hello', {edited: true});
  assert.equal(f.reactions.length, 2);
  await f.run('.trace kw del hello');
  await f.listen('hello');
  assert.equal(f.reactions.length, 2);
});

test('trace reads legacy string reaction IDs and preserves unrelated stored metadata', async t => {
  const f = await fixture(t, {initial: {
    users: {'77': ['👍', '9007199254740993']}, keywords: {},
    config: {big: false, keepLog: true, marker: 'keep'}, marker: 'keep',
  }});
  await f.listen('hello');
  assert.equal(f.reactions[0].reaction[1].documentId.toString(), '9007199254740993');
  await f.run('.trace big true');
  const saved = await f.read();
  assert.equal(saved.marker, 'keep');
  assert.equal(saved.config.marker, 'keep');
});

for (const premium of [true, false]) {
  test(`trace custom entity admission with premium=${premium}`, async t => {
    const f = await fixture(t, {premium});
    const text = '.trace kw add hello 👍';
    const bigInt = require(path.join(core, 'node_modules/big-integer'));
    await f.run(text, {raw: {entities: [new Api.MessageEntityCustomEmoji({
      offset: text.indexOf('👍'), length: 2, documentId: bigInt('9007199254740993'),
    })]}});
    await f.listen('hello');
    if (premium) {
      assert.equal(f.reactions[0].reaction[0].documentId.toString(), '9007199254740993');
      assert.equal((await f.read()).keywords.hello[0].documentId, '9007199254740993');
    } else {
      assert.equal(f.reactions.length, 0);
      assert.match(f.edits.at(-1), /失败/);
    }
  });
}

test('trace unload cancels the pending receipt deletion', async t => {
  const f = await fixture(t);
  await f.run('.trace log false');
  assert.equal(f.deleted.length, 0);
  const result = await f.shutdown();
  assert.equal(result.completed, true);
  assert.equal(f.deleted.length, 0);
});

test('trace deletes the command receipt after its delay', {timeout: 15000}, async t => {
  const f = await fixture(t);
  await f.run('.trace log false');
  assert.equal(f.deleted.length, 0);
  await f.deletionDone;
  assert.equal(f.deleted[0][0].toString(), '123');
  assert.deepEqual(f.deleted[0][1], [1]);
  assert.deepEqual(f.deleted[0][2], {revoke: true});
});
test('trace user selection takes precedence and untracking restores keyword match', async t => {
  const f = await fixture(t);
  await f.run('.trace kw add hello 👍');
  f.reply({id: 9, chatId: '123', senderId: '77', text: 'hello', outgoing: false});
  await f.run('.trace 🔥');
  assert.equal(f.reactions[0].msgId, 9);
  await f.listen('hello');
  assert.equal(f.reactions[1].reaction[0].emoticon, '🔥');
  await f.run('.trace');
  await f.listen('hello');
  assert.equal(f.reactions[2].reaction[0].emoticon, '👍');
  await f.run('.trace clean');
  await f.listen('hello');
  assert.equal(f.reactions.length, 3);
});
