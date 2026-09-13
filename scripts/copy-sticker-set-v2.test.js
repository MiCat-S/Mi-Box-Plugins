'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {prepareArtifact} = require(path.join(core, 'dist/v2/artifacts.js'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {Api, utils} = require(path.join(core, 'node_modules/teleproto'));

let artifact;
test.before(async () => {
  const built = buildPlugin({id: 'copy_sticker_set', packageRoot: path.resolve(__dirname, '../copy_sticker_set'), entry: 'v2.ts'});
  artifact = await prepareArtifact(built.artifactDir);
});
test.after(() => artifact?.release());

function sticker(id = 9007199254740993n, accessHash = 9007199254740995n, alt = '😀') {
  return Object.assign(Object.create(Api.Document.prototype), {
    id, accessHash, fileReference: Buffer.from('file-reference'),
    attributes: alt == null ? [] : [Object.assign(Object.create(Api.DocumentAttributeSticker.prototype), {alt})],
  });
}

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-copy-set-v2-')));
  const edits = [], completedEdits = [], calls = [], logs = [], signals = [];
  const documents = options.documents ?? [sticker()];
  const source = options.source ?? {set: {title: '<Original>'}, documents};
  const createResult = options.createResult === undefined
    ? Object.assign(Object.create(Api.messages.StickerSet.prototype), {set: {title: 'copy'}, documents: []})
    : options.createResult;
  let activeSignal;
  const client = {
    async getInputEntity(value) {
      return value === 'me' ? new Api.InputPeerSelf() : value;
    },
    async invoke(request) {
      await request.resolve(client, utils);
      const bytes = request.getBytes();
      assert.ok(bytes.length > 4);
      calls.push({request, bytes});
      if (request instanceof Api.messages.GetStickerSet) {
        if (options.lookupError) throw options.lookupError;
        return source;
      }
      assert.equal(request instanceof Api.stickers.CreateStickerSet, true);
      await options.onCreate?.(request, activeSignal);
      if (options.createError) throw options.createError;
      return createResult;
    },
  };
  const host = new PluginHost({storageRoot: root, prefixes: options.prefixes ?? ['.'], logger: {
    info(event, fields) {logs.push({level: 'info', event, fields});},
    error(event, fields) {logs.push({level: 'error', event, fields});},
  }, telegram: {
    async edit(message, text, editOptions) {
      const entry = {message, text, options: editOptions};
      edits.push(entry);
      await options.onEdit?.(text);
      completedEdits.push(entry);
    },
    async reply() {assert.fail('unexpected reply');},
    async invoke() {assert.fail('unexpected direct invoke');},
    async getReply() {assert.fail('unexpected reply lookup');},
    async withClient(operation, signal) {
      signals.push(signal);
      activeSignal = signal;
      try {return await operation(client, signal);}
      finally {activeSignal = undefined;}
    },
  }});
  const definition = artifact.create();
  await host.load(definition);
  t.after(async () => {
    assert.equal((await host.shutdown(2000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  const run = text => host.dispatchPrimary({id: 1, chatId: '123', senderId: '9007199254740993', outgoing: true, text});
  return {host, definition, edits, completedEdits, calls, logs, signals, run};
}

test('copy_sticker_set serializes exact sticker ids and reports bounded progress', async t => {
  const first = sticker();
  const f = await fixture(t, {documents: [first, sticker(9007199254740997n)]});
  await f.run('.css https://t.me/addstickers/source My Set limit=1');
  assert.equal(f.calls.length, 2);
  const lookup = f.calls[0].request;
  const create = f.calls[1].request;
  assert.equal(lookup instanceof Api.messages.GetStickerSet, true);
  assert.equal(lookup.stickerset.shortName, 'source');
  assert.equal(create instanceof Api.stickers.CreateStickerSet, true);
  assert.equal(create.userId instanceof Api.InputUserSelf, true);
  assert.equal(create.title, 'My Set');
  assert.equal(create.stickers.length, 1);
  assert.equal(create.stickers[0].document.id.toString(), '9007199254740993');
  assert.equal(create.stickers[0].document.accessHash.toString(), '9007199254740995');
  assert.deepEqual(create.stickers[0].document.fileReference, Buffer.from('file-reference'));
  assert.equal(create.stickers[0].emoji, '😀');
  assert.ok(create.shortName.length <= 64);
  assert.ok(f.edits.some(entry => /找到贴纸包.*2 个贴纸/s.test(entry.text)));
  assert.ok(f.edits.some(entry => /只复制前 1 个贴纸/.test(entry.text)));
  assert.ok(f.edits.some(entry => /处理贴纸 1\/1/.test(entry.text)));
  assert.match(f.edits.at(-1).text, /&lt;Original&gt;[\s\S]*My Set[\s\S]*数量：1/);
  assert.equal(f.edits.at(-1).options.linkPreview, false);
});

test('copy_sticker_set skips incompatible entries and keeps the fallback emoji', async t => {
  const f = await fixture(t, {documents: [{className: 'Photo'}, sticker(7n, 8n, null)]});
  await f.run('.copy_sticker_set source limit=2');
  const create = f.calls.at(-1).request;
  assert.equal(create.stickers.length, 1);
  assert.equal(create.stickers[0].emoji, '🙂');
  assert.equal(create.title, '<Original> (复制)');
  assert.match(f.edits.at(-1).text, /数量：1/);
});

test('copy_sticker_set exposes full dynamic-prefix help and validates arguments before RPC', async t => {
  const f = await fixture(t, {prefixes: ['<&']});
  await f.run('<&css');
  assert.match(f.edits.at(-1).text, /参数说明/);
  assert.match(f.edits.at(-1).text, /&lt;&amp;css example_stickers/);
  for (const [text, expected] of [
    ['<&css source limit=0', /limit 参数无效/],
    ['<&css source limit=121', /最多 120 张贴纸/],
    ['<&css https://t.me/addstickers/', /链接格式错误/],
    ['<&css https://evil.test/addstickers/a', /参数错误/],
    ['<&css bad-name', /参数错误/],
  ]) {
    await f.run(text);
    assert.match(f.edits.at(-1).text, expected);
  }
  assert.equal(f.calls.length, 0);
});

test('copy_sticker_set distinguishes lookup, empty, and invalid create responses', async t => {
  const missingSecret = '/Users/private/session key=secret https://private.example/';
  const missing = await fixture(t, {lookupError: new Error(`STICKERSET_INVALID ${missingSecret}`)});
  await missing.run('.css absent');
  assert.match(missing.edits.at(-1).text, /贴纸包不存在[\s\S]*absent/);
  assert.equal(JSON.stringify(missing.edits).includes(missingSecret), false);
  assert.equal(JSON.stringify(missing.logs).includes(missingSecret), false);

  const empty = await fixture(t, {source: {set: {title: 'Empty'}, documents: []}});
  await empty.run('.css empty');
  assert.match(empty.edits.at(-1).text, /贴纸包为空/);
  assert.equal(empty.calls.length, 1);

  const incompatible = await fixture(t, {documents: [{className: 'Photo'}]});
  await incompatible.run('.css incompatible');
  assert.match(incompatible.edits.at(-1).text, /处理失败/);
  assert.equal(incompatible.calls.length, 1);

  const invalid = await fixture(t, {createResult: {set: {title: 'not-a-tl-result'}}});
  await invalid.run('.css source');
  assert.match(invalid.edits.at(-1).text, /创建失败/);
  assert.doesNotMatch(invalid.edits.at(-1).text, /复制完成/);
});

test('copy_sticker_set keeps known create errors understandable and unknown details private', async t => {
  const cases = [
    ['STICKERSET_INVALID', /数据无效/],
    ['PEER_ID_INVALID', /用户ID无效/],
    ['SHORTNAME_OCCUPY_FAILED', /名称被占用/],
    ['CreateStickerSet timeout', /创建超时/],
    ['unclassified', /创建贴纸包时出现错误/],
  ];
  for (const [code, expected] of cases) {
    const secret = `/Users/private/${code} token=secret https://private.example/?key=hidden`;
    const f = await fixture(t, {createError: new Error(`${code} ${secret}`)});
    await f.run('.css source');
    assert.match(f.edits.at(-1).text, expected);
    assert.equal(JSON.stringify(f.edits).includes(secret), false);
    assert.equal(JSON.stringify(f.logs).includes(secret), false);
    assert.equal(f.logs.every(entry => entry.fields === undefined), true);
  }
});

test('copy_sticker_set warns at sixty seconds without settling the in-flight RPC', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let entered;
  const started = new Promise(resolve => {entered = resolve;});
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, {onCreate: async () => {entered(); await gate;}});
  let settled = false;
  const running = f.run('.css source').finally(() => {settled = true;});
  await started;

  t.mock.timers.tick(59_999);
  await Promise.resolve();
  const warnedEarly = f.edits.some(entry => /操作仍在等待服务器确认/.test(entry.text));
  t.mock.timers.tick(1);
  await Promise.resolve();
  await Promise.resolve();
  const warningCount = f.edits.filter(entry => /操作仍在等待服务器确认/.test(entry.text)).length;
  const settledAtDeadline = settled;

  release();
  await running;
  assert.equal(warnedEarly, false);
  assert.equal(warningCount, 1);
  assert.equal(settledAtDeadline, false);
  assert.match(f.edits.at(-1).text, /复制完成/);
});

test('copy_sticker_set waits for an in-flight timeout edit before final success', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let createEntered;
  const createStarted = new Promise(resolve => {createEntered = resolve;});
  let releaseCreate;
  const createGate = new Promise(resolve => {releaseCreate = resolve;});
  let noticeEntered;
  const noticeStarted = new Promise(resolve => {noticeEntered = resolve;});
  let releaseNotice;
  const noticeGate = new Promise(resolve => {releaseNotice = resolve;});
  const f = await fixture(t, {
    onCreate: async () => {createEntered(); await createGate;},
    onEdit: async text => {
      if (/操作仍在等待服务器确认/.test(text)) {
        noticeEntered();
        await noticeGate;
      }
    },
  });
  const running = f.run('.css source');
  await createStarted;
  t.mock.timers.tick(60_000);
  await noticeStarted;

  releaseCreate();
  await new Promise(resolve => setImmediate(resolve));
  const successCompletedBeforeNotice = f.completedEdits.some(entry => /复制完成/.test(entry.text));
  releaseNotice();
  await running;
  await new Promise(resolve => setImmediate(resolve));

  const finalOrder = f.completedEdits.filter(entry => /操作仍在等待服务器确认|复制完成/.test(entry.text))
    .map(entry => /复制完成/.test(entry.text) ? 'success' : 'timeout');
  assert.equal(successCompletedBeforeNotice, false);
  assert.deepEqual(finalOrder, ['timeout', 'success']);
});

test('copy_sticker_set absorbs a failed timeout notification before final success', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let createEntered;
  const createStarted = new Promise(resolve => {createEntered = resolve;});
  let releaseCreate;
  const createGate = new Promise(resolve => {releaseCreate = resolve;});
  let noticeAttempted;
  const attempted = new Promise(resolve => {noticeAttempted = resolve;});
  const secret = '/Users/private/notice token=secret https://private.example/?key=hidden';
  const f = await fixture(t, {
    onCreate: async () => {createEntered(); await createGate;},
    onEdit: text => {
      if (/操作仍在等待服务器确认/.test(text)) {
        noticeAttempted();
        throw new Error(secret);
      }
    },
  });
  const running = f.run('.css source');
  await createStarted;
  t.mock.timers.tick(60_000);
  await attempted;
  releaseCreate();
  await running;

  assert.match(f.edits.at(-1).text, /复制完成/);
  assert.deepEqual(f.logs.filter(entry => entry.level === 'error'), [
    {level: 'error', event: 'copy_sticker_set_timeout_notice_failed', fields: undefined},
  ]);
  assert.equal(JSON.stringify(f.logs).includes(secret), false);
  assert.equal(JSON.stringify(f.edits).includes(secret), false);
});

test('copy_sticker_set clears timeout notice after timely success and failure', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const success = await fixture(t);
  await success.run('.css source');
  const failure = await fixture(t, {createError: new Error('STICKERSET_INVALID')});
  await failure.run('.css source');

  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(success.edits.some(entry => /操作仍在等待服务器确认/.test(entry.text)), false);
  assert.equal(failure.edits.some(entry => /操作仍在等待服务器确认/.test(entry.text)), false);
});

test('copy_sticker_set waits for an in-flight RPC and suppresses success after unload', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let entered;
  const started = new Promise(resolve => {entered = resolve;});
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, {onCreate: async () => {entered(); await gate;}});
  const running = f.run('.css source');
  await started;
  let unloadSettled = false;
  const unloading = f.host.unload('copy_sticker_set', 120_000).finally(() => {unloadSettled = true;});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.signals.some(signal => signal.aborted), true);
  assert.equal(unloadSettled, false);
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(f.edits.some(entry => /操作仍在等待服务器确认/.test(entry.text)), false);
  assert.equal(unloadSettled, false);
  release();
  const report = await unloading;
  assert.equal(report.completed, true);
  await Promise.allSettled([running]);
  assert.equal(f.edits.some(entry => /复制完成/.test(entry.text)), false);
});
