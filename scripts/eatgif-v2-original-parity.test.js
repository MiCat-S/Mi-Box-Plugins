'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = process.env.TELEBOX_CORE_ROOT || path.resolve(__dirname, '../../TeleBox-Core');
const plugins = process.env.TELEBOX_PLUGIN_ROOT || path.resolve(__dirname, '..');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'eatgif', packageRoot: path.join(plugins, 'eatgif'), entry: 'v2.ts'});
const moduleUnderTest = require(path.join(artifactDir, 'index.cjs'));
const {Api, utils} = require(path.join(core, 'node_modules/teleproto'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {ResourceScope} = require(path.join(core, 'dist/v2/lifecycle.js'));
const {ScopedFiles} = require(path.join(core, 'dist/v2/files.js'));
const sharp = require(path.join(core, 'node_modules/sharp'));

test('accepts every shipped animation while rejecting loose numeric and excessive pixel budgets', async () => {
  assert.equal(typeof moduleUnderTest.validateDetail, 'function');
  for (const name of ['md/md.json', 'ddw/ddw.json']) {
    const detail = JSON.parse(await fs.readFile(path.join(plugins, 'eatgif', name), 'utf8'));
    assert.equal(moduleUnderTest.validateDetail(detail), detail, `${name} must remain reachable`);
  }
  assert.throws(() => moduleUnderTest.validateDetail({width: '2', height: 2, res: [{url: 'frame.png'}]}), /Invalid animation/);
  assert.throws(() => moduleUnderTest.validateDetail({width: 512, height: 512,
    res: Array.from({length: 65}, () => ({url: 'frame.png'}))}), /Invalid animation/);
});

test('downloads avatars through one direct photo-DC request', async () => {
  assert.equal(typeof moduleUnderTest.downloadAvatarDirect, 'function');
  const entity = new Api.User({id: 123, accessHash: 456, firstName: 'Visible',
    photo: new Api.UserProfilePhoto({photoId: 789, dcId: 5})});
  let request;
  let dc;
  const expected = Buffer.from('avatar');
  const actual = await moduleUnderTest.downloadAvatarDirect({
    async getEntity() { return entity; },
    async downloadProfilePhoto() { throw new Error('scheduler path must not run'); },
    async invoke(value, targetDc) {
      request = value; dc = targetDc;
      return new Api.upload.File({type: new Api.storage.FileJpeg(), mtime: 0, bytes: expected});
    },
  }, entity.id, new AbortController().signal);
  assert.deepEqual(actual, expected);
  assert.equal(dc, 5);
  assert.ok(request instanceof Api.upload.GetFile);
  assert.ok(request.location instanceof Api.InputPeerPhotoFileLocation);
  assert.equal(request.location.photoId.toString(), '789');
  assert.equal(request.location.big, false);
  await request.resolve({}, utils);
  assert.ok(request.getBytes().length > 0, 'direct avatar request must serialize with the installed TL layer');
});

test('actively cancels a blocked HTTP reader and stops avatar RPC chains after cancellation', async () => {
  const controller = new AbortController();
  let cancelled = 0;
  let releaseRead;
  const reading = new Promise(resolve => { releaseRead = resolve; });
  const pending = moduleUnderTest.responseBytes({http: {withResponse: async (_url, _options, use) => use({ok: true,
    body: {getReader: () => ({read: () => reading, async cancel() { cancelled += 1; releaseRead({done: true}); }, releaseLock() {}})}}, controller.signal)}},
  new URL('https://github.com/frame.png'), 10);
  controller.abort();
  await assert.rejects(pending, error => error?.name === 'AbortError');
  assert.ok(cancelled >= 1);

  const avatarController = new AbortController();
  let invokes = 0;
  let releaseEntity;
  const entityGate = new Promise(resolve => { releaseEntity = resolve; });
  const avatarPending = moduleUnderTest.downloadAvatarDirect({async getEntity() { await entityGate; return {}; }, async invoke() { invokes += 1; }},
    1, avatarController.signal);
  avatarController.abort(); releaseEntity();
  await assert.rejects(avatarPending, error => error?.name === 'AbortError');
  assert.equal(invokes, 0);

  const uploadController = new AbortController();
  let releaseUpload;
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  let deletes = 0;
  const uploadPending = moduleUnderTest.uploadResult({signal: uploadController.signal, log: {info() {}, error() {}},
    telegram: {withClient: async use => use({async sendFile() { await uploadGate; }}, uploadController.signal)}},
  {peerId: 'peer', async delete() { deletes += 1; }}, '/tmp/output.gif', '/tmp/output.webm', 1, uploadController.signal);
  await new Promise(resolve => setImmediate(resolve));
  uploadController.abort(); releaseUpload();
  await assert.rejects(uploadPending, error => error?.name === 'AbortError');
  assert.equal(deletes, 0, 'an upload cancelled in flight must not issue the later delete RPC');
});

test('scope unload waits for the first reader cancellation and retains its task directory until release', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'eatgif-reader-cleanup-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const scope = new ResourceScope();
  const files = new ScopedFiles(scope, path.join(root, 'data'), path.join(root, 'temp'), 'eatgif');
  let temporary;
  let releaseRead;
  let releaseCleanup;
  let markStarted;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  let cancelCalls = 0;
  let releases = 0;
  const reader = {
    read() { markStarted(); return readGate; },
    async cancel() { cancelCalls += 1; releaseRead({done: true}); await cleanupGate; },
    releaseLock() { releases += 1; },
  };
  const work = files.withTemp(async (directory, signal) => {
    temporary = directory;
    return moduleUnderTest.responseBytes({http: {withResponse: (_url, _options, use) =>
      use({ok: true, body: {getReader: () => reader}}, signal)}}, new URL('https://github.com/frame.png'), 10);
  });
  void work.catch(() => undefined);
  await Promise.race([started, work]);
  const firstDrain = scope.drain(5);
  const report = await firstDrain;
  assert.equal(report.completed, false);
  assert.equal(report.pendingTasks, 1);
  assert.equal((await fs.stat(temporary)).isDirectory(), true);
  assert.equal(cancelCalls, 1, 'abort and finally must share the first cancellation promise');
  assert.equal(releases, 0);
  releaseCleanup();
  await assert.rejects(work);
  assert.equal((await scope.drain(1000)).pendingTasks, 0);
  await assert.rejects(fs.stat(temporary), {code: 'ENOENT'});
  assert.equal(cancelCalls, 1);
  assert.equal(releases, 1);
});

test('routes list through the real Host and uses the active prefix', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eatgif-host-'));
  const edits = [], replies = [];
  const catalog = Object.fromEntries(Array.from({length: 240}, (_, index) => [`item${index}`, {url: 'demo.json', desc: `<Demo ${index}>`} ]));
  const host = new PluginHost({storageRoot: root, tempRoot: path.join(root, 'temp'), prefixes: ['!'],
    processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 180_000, maxOutputBytes: 256 * 1024},
    logger: {info() {}, error() {}},
    http: {fetch: async () => new Response(JSON.stringify(catalog))},
    telegram: {
      async edit(_message, text, options) { edits.push({text, options}); }, async reply(_message, text, options) { replies.push({text, options}); }, async invoke() {},
      async getReply() {}, async withClient() { assert.fail('list must not acquire Telegram client'); },
    },
  });
  await host.load(moduleUnderTest.default());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  await host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text: '!eatgif list'});
  assert.match(edits.at(-1).text, /<code>!eatgif 名称<\/code>/);
  assert.match(edits.at(-1).text, /&lt;Demo 0&gt;/);
  assert.equal(edits.at(-1).options.parseMode, 'html');
  assert.ok(replies.length > 0, 'complete catalogs must use SDK pagination');
  assert.match(replies.at(-1).text, /item239/);
  await host.dispatchPrimary({id: 2, chatId: '1', senderId: '1', outgoing: true, text: '!eatgif missing'});
  assert.match(edits.at(-1).text, /未找到：[\s\S]*item0[\s\S]*&lt;Demo 0&gt;/);
});

test('keeps HTTP bodies owned, clears in-flight cache atomically, and falls back to GIF with fixed FFmpeg argv', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eatgif-v2-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const frame = await sharp({create: {width: 2, height: 2, channels: 4, background: '#ff0000ff'}}).png().toBuffer();
  const avatar = new Api.User({id: 1, accessHash: 2, firstName: 'Avatar',
    photo: new Api.UserProfilePhoto({photoId: 3, dcId: 4})});
  const payloads = new Map([
    ['config.json', Buffer.from(JSON.stringify({demo: {url: 'demo.json', desc: 'Demo'}}))],
    ['demo.json', Buffer.from(JSON.stringify({width: 2, height: 2, res: [{url: 'frame.png', delay: 50}]}))],
    ['frame.png', frame],
  ]);
  let frameReads = 0;
  let bodyCancels = 0;
  let releaseFrame;
  const frameGate = new Promise(resolve => { releaseFrame = resolve; });
  const processCalls = [];
  const uploads = [];
  const edits = [];
  const logs = [];
  let holdStaging = false;
  let stagingEntered = 0;
  let releaseStaging;
  let stagingGate = Promise.resolve();
  const context = {
    signal: new AbortController().signal,
    log: {info(event) { logs.push(event); }, error(event) { logs.push(event); }},
    files: {
      dataPath(relative) { return path.join(root, 'data', relative); },
      async dataFile(relative) { const target = path.join(root, 'data', relative); await fs.mkdir(path.dirname(target), {recursive: true});
        if (holdStaging && relative.endsWith('.part')) { stagingEntered += 1; await stagingGate; } return target; },
      async withTemp(use) { const directory = await fs.mkdtemp(path.join(root, 'job-')); try { return await use(directory, context.signal); } finally { await fs.rm(directory, {recursive: true, force: true}); } },
    },
    http: {
      async withResponse(url, _options, use) {
        const name = new URL(url).pathname.split('/').at(-1);
        const payload = payloads.get(name);
        if (!payload) throw new Error('unexpected URL');
        if (name === 'frame.png') { frameReads += 1; await frameGate; }
        let done = false;
        const reader = {
          async read() { if (done) return {done: true}; done = true; return {done: false, value: payload}; },
          async cancel() { bodyCancels += 1; },
          releaseLock() {},
        };
        return use({ok: true, body: {getReader: () => reader}}, context.signal);
      },
    },
    processes: {async run(command, args, options) { processCalls.push({command, args, options}); throw Object.assign(new Error('hidden-secret'), {code: 'SPAWN_FAILED'}); }},
    telegram: {
      async edit(_message, text) { edits.push(text); },
      async getReply() { return {raw: {sender: avatar, senderId: avatar.id}}; },
      async withClient(use) { return use({
        async getMe() { return avatar; },
        async invoke() { return new Api.upload.File({type: new Api.storage.FileJpeg(), mtime: 0, bytes: frame}); },
        async sendFile(_peer, options) { uploads.push({file: options.file, data: await fs.readFile(options.file), attributes: options.attributes}); },
      }, context.signal); },
    },
  };
  const plugin = moduleUnderTest.default();
  const message = {id: 1, chatId: '1', outgoing: true, text: '.eatgif demo', replyToId: 9,
    raw: {peerId: {id: 1}, async delete() { throw new Error('private-delete-failure'); }}};
  const run = plugin.commands.eatgif.handle({command: 'eatgif', prefix: '.', args: ['demo'], message}, context);
  const concurrentRun = plugin.commands.eatgif.handle({command: 'eatgif', prefix: '.', args: ['demo'],
    message: {...message, id: 2, raw: {...message.raw, async delete() {}}}}, context);
  while (frameReads === 0) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frameReads, 1, 'concurrent requests must share the same generation cache fill');
  await plugin.commands.eatgif.handle({command: 'eatgif', prefix: '.', args: ['clear'], message: {...message, replyToId: undefined}}, context);
  releaseFrame();
  await Promise.all([run, concurrentRun]);

  assert.ok(bodyCancels >= 3, 'every consumed response reader must be cancelled/released');
  await assert.rejects(fs.stat(path.join(root, 'data', 'cache')), {code: 'ENOENT'});
  assert.equal(uploads.length, 2);
  for (const upload of uploads) {
    assert.equal(path.extname(upload.file), '.gif');
    assert.ok(upload.data.length > 0 && upload.data.length <= 20 * 1024 * 1024);
    assert.equal(upload.attributes, undefined);
  }
  assert.ok(processCalls.length >= 1);
  for (const call of processCalls) {
    assert.deepEqual(call.args, ['-nostdin', '-y', '-protocol_whitelist', 'file', '-i', 'output.gif', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '41', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-fs', String(20 * 1024 * 1024), 'output.webm']);
    assert.match(call.options.cwd, /job-/);
  }
  assert.ok(!edits.some(text => text.includes('hidden-secret')), 'native failures must stay redacted');
  assert.ok(!edits.some(text => text.includes('private-delete-failure')));
  assert.ok(logs.includes('eatgif_receipt_cleanup_failed'));

  holdStaging = true;
  stagingGate = new Promise(resolve => { releaseStaging = resolve; });
  const publishing = plugin.commands.eatgif.handle({command: 'eatgif', prefix: '.', args: ['demo'], message}, context);
  while (stagingEntered === 0) await new Promise(resolve => setImmediate(resolve));
  let clearFinished = false;
  const clearing = plugin.commands.eatgif.handle({command: 'eatgif', prefix: '.', args: ['clear'], message: {...message, replyToId: undefined}}, context)
    .then(() => { clearFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clearFinished, false, 'clear must serialize behind an asset already in its publish section');
  releaseStaging();
  await Promise.all([publishing, clearing]);
  await assert.rejects(fs.stat(path.join(root, 'data', 'cache')), {code: 'ENOENT'});
});
