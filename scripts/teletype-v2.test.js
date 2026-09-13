'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'teletype', packageRoot: path.resolve(__dirname, '../teletype'), entry: 'v2.ts'});
const moduleUnderTest = require(path.join(artifactDir, 'index.cjs'));

async function fixture(t, prefixes = ['.'], options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-teletype-v2-')));
  if (options.initialConfig) {
    await fs.mkdir(path.join(root, 'teletype'), {recursive: true});
    await fs.writeFile(path.join(root, 'teletype/config.json'), JSON.stringify(options.initialConfig));
  }
  const edits = [];
  const host = new PluginHost({
    storageRoot: root,
    prefixes,
    logger: {info() {}, error() {}},
    telegram: {
      async edit(message, text, messageOptions, signal) {
        signal.throwIfAborted();
        if (options.editFailure) await options.editFailure({message, text});
        edits.push({message, text, options: messageOptions, at: Date.now()});
      },
      async reply() { assert.fail('unexpected reply'); },
      async invoke() { assert.fail('unexpected invoke'); },
      async getReply() { return undefined; },
      async withClient(operation, signal) { return operation({}, signal); },
    },
  });
  await host.load(moduleUnderTest.default());
  t.after(async () => {
    await host.shutdown(1000);
    await fs.rm(root, {recursive: true, force: true});
  });
  let id = 0;
  const message = (text, extra = {}) => ({id: ++id, chatId: '42', senderId: '7', outgoing: true, text, ...extra});
  return {host, edits, message, run(text, extra) { return host.dispatchPrimary(message(text, extra)); }};
}

test('empty command keeps the legacy parameter-error usage and active prefix', async t => {
  const f = await fixture(t, ['!']);
  await f.run('!teletype');
  assert.match(f.edits.at(-1).text, /^❌ <b>参数错误<\/b>/);
  assert.match(f.edits.at(-1).text, /!teletype/);
});

test('manual animation preserves Unicode code points, HTML escaping and the legacy edit rate', async t => {
  const f = await fixture(t);
  await f.run('.teletype 😀<&');
  assert.deepEqual(f.edits.map(item => item.text), ['█', '😀█', '😀', '😀&lt;█', '😀&lt;', '😀&lt;&amp;█', '😀&lt;&amp;', '😀&lt;&amp;']);
  assert.equal(moduleUnderTest.EDIT_INTERVAL_MS, 50);
  for (let index = 1; index < f.edits.length - 1; index++) {
    assert.ok(f.edits[index].at - f.edits[index - 1].at >= 35, 'edits remain paced instead of bursting');
  }
});

test('automatic mode applies only to eligible outgoing, unedited, non-command messages', async t => {
  const f = await fixture(t);
  await f.run('.teletype on');
  f.edits.length = 0;
  await f.host.dispatchListeners(f.message('自动'));
  assert.equal(f.edits.at(-1).text, '自动');
  const count = f.edits.length;
  await f.host.dispatchListeners(f.message('传入', {outgoing: false}));
  await f.host.dispatchListeners(f.message('编辑', {edited: true}));
  await f.host.dispatchListeners(f.message('.status'));
  await f.host.dispatchListeners(f.message('x'));
  assert.equal(f.edits.length, count);
});

test('on, off and status preserve the legacy global switch and per-user membership', async t => {
  const f = await fixture(t);
  await f.run('.teletype on', {senderId: '7'});
  await f.run('.teletype on', {senderId: '8'});
  await f.run('.teletype off', {senderId: '7'});
  assert.equal(f.edits.at(-1).text, '❌ <b>自动打字机模式已关闭</b>');
  await f.run('.teletype status', {senderId: '8'});
  assert.match(f.edits.at(-1).text, /🟢 开启/);
  const count = f.edits.length;
  await f.host.dispatchListeners(f.message('不会自动', {senderId: '8'}));
  assert.equal(f.edits.length, count, 'legacy off disables the global automatic-mode gate');
  await f.run('.teletype status', {senderId: undefined});
  assert.match(f.edits.at(-1).text, /🔴 关闭/);
  await f.run('.teletype off', {senderId: undefined});
  assert.equal(f.edits.at(-1).text, '❌ <b>自动打字机模式已关闭</b>');
});

test('maxEdits bounds Unicode animation without truncating its final text', async t => {
  const f = await fixture(t);
  await f.host.patchSettings('teletype', {maxEdits: 2});
  const text = '😀甲乙丙丁';
  await f.run(`.teletype ${text}`);
  assert.equal(f.edits.length, 2);
  assert.equal(f.edits.at(-1).text, text);
});

test('MESSAGE_NOT_MODIFIED in an intermediate batch still reaches the complete final text', async t => {
  let calls = 0;
  const f = await fixture(t, ['.'], {editFailure() {
    if (++calls === 4) throw Object.assign(new Error('MESSAGE_NOT_MODIFIED'), {errorMessage: 'MESSAGE_NOT_MODIFIED'});
  }});
  await f.run('.teletype abc');
  assert.equal(f.edits.at(-1).text, 'abc');
  assert.ok(f.edits.some(item => item.text === 'abc█'));
});

test('a fractional maxEdits is normalized to a finite integer at the animation entry', async t => {
  const f = await fixture(t);
  await f.host.patchSettings('teletype', {maxEdits: 2.9});
  await f.run('.teletype 甲乙');
  assert.equal(f.edits.length, 2);
  assert.equal(f.edits[0].text, '█');
  assert.equal(f.edits.at(-1).text, '甲乙');
});

test('non-numeric historical maxEdits does not skip progressive body edits', async t => {
  const f = await fixture(t, ['.'], {initialConfig: {schemaVersion: 1, autoMode: false, enabledUsers: [], maxEdits: 'invalid'}});
  await f.run('.teletype 甲乙');
  assert.ok(f.edits.some(item => item.text === '甲█'));
  assert.equal(f.edits.at(-1).text, '甲乙');
});

test('unload aborts the managed edit delay and prevents later edits', async t => {
  const f = await fixture(t);
  const pending = f.run('.teletype abc').catch(error => error);
  while (!f.edits.length) await new Promise(resolve => setImmediate(resolve));
  const report = await f.host.unload('teletype', 1000);
  const error = await pending;
  assert.equal(report.completed, true);
  assert.ok(error && (error.name === 'AbortError' || error.name === 'TelegramAbortError'));
  assert.deepEqual(f.edits.map(item => item.text), ['█']);
});
