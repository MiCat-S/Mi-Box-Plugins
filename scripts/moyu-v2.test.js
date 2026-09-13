'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'moyu', packageRoot: path.resolve(__dirname, '../moyu'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==', 'base64');

function fixture(response, options = {}) {
  const controller = new AbortController();
  const edits = [], events = [], uploads = [], deletions = [], logs = [];
  const peer = {channelId: 123};
  const message = {id: 7, chatId: '-100123', outgoing: true, text: '.moyu', raw: {peerId: peer}, topicId: 9};
  let fetching = false;
  const ctx = {
    signal: controller.signal,
    http: {async withResponse(url, init, consume, limits) {
      assert.equal(url, 'https://api.52vmy.cn/api/wl/moyu');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal(new Headers(init.headers).get('Accept'), 'image/*');
      assert.equal(limits.timeoutMs, 15000);
      assert.equal(limits.signal, controller.signal);
      assert.deepEqual(limits.redirects, {allowedHosts: ['api.52vmy.cn'], maxRedirects: 2});
      fetching = true;
      try {return await consume(response, controller.signal);}
      finally {fetching = false;}
    }},
    telegram: {
      async edit(_, text) {edits.push(text);},
      async withClient(operation) {
        assert.equal(fetching, false);
        return operation({
          async sendFile(...args) {
            events.push('send'); uploads.push(args);
            if (options.uploadError) throw new Error('upload');
            if (options.upload) await options.upload(...args);
          },
          async deleteMessages(...args) {
            events.push('delete'); deletions.push(args);
            if (options.deleteError) throw new Error('delete');
          },
        }, controller.signal);
      },
    },
    log: {error(event) {logs.push(event);}},
  };
  return {controller, edits, events, uploads, deletions, logs, peer, message,
    run: (args = []) => create().commands.moyu.handle({message, args, command: 'moyu', prefix: '.'}, ctx)};
}

test('moyu uploads after download and deletes command after successful send', async () => {
  const f = fixture(new Response(image));
  await f.run();
  assert.deepEqual(f.events, ['send', 'delete']);
  assert.equal(f.uploads[0][0], f.peer);
  const options = f.uploads[0][1];
  assert.equal(options.file.size, image.length);
  assert.equal(options.forceDocument, false);
  assert.equal(options.replyTo, 9);
  assert.match(options.caption, /^摸鱼日报 /);
  assert.deepEqual(f.deletions[0], [f.peer, [7], {revoke: true}]);
  assert.equal(f.edits.length, 1);
});

test('moyu preserves explicit reply target', async () => {
  const f = fixture(new Response(image));
  f.message.replyToId = 11;
  await f.run();
  assert.equal(f.uploads[0][1].replyTo, 11);
});

for (const scenario of ['oversize', 'abort', 'empty', 'readError']) {
  test(`moyu ${scenario} releases download and never uploads`, async () => {
    let canceled = 0, entered;
    const reading = new Promise(resolve => {entered = resolve;});
    const response = new Response(new ReadableStream({
      start(target) {
        if (scenario === 'oversize') target.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
        if (scenario === 'empty') target.close();
        if (scenario === 'readError') target.error(new Error('network'));
      },
      pull() {entered();},
      cancel() {canceled++;},
    }));
    const f = fixture(response);
    const running = f.run();
    if (scenario === 'abort') {await reading; f.controller.abort();}
    await running;
    assert.equal(response.body.locked, false);
    assert.equal(canceled, ['oversize', 'abort'].includes(scenario) ? 1 : 0);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.deletions.length, 0);
    if (scenario === 'abort') assert.equal(f.edits.length, 1);
    else assert.match(f.edits.at(-1), /获取摸鱼日报失败/);
  });
}

test('moyu rejects HTTP failure and never deletes on upload failure', async () => {
  for (const f of [fixture(new Response('error', {status: 503})),
    fixture(new Response(image), {uploadError: true})]) {
    await f.run();
    assert.equal(f.deletions.length, 0);
    assert.match(f.edits.at(-1), /获取摸鱼日报失败/);
  }
});

test('moyu reports successful upload separately from command deletion failure', async () => {
  const f = fixture(new Response(image), {deleteError: true});
  await f.run();
  assert.deepEqual(f.events, ['send', 'delete']);
  assert.equal(f.edits.at(-1), '摸鱼日报已发送，命令消息删除失败');
  assert.deepEqual(f.logs, ['moyu_delete_failed']);
});

test('moyu help performs no download or upload', async () => {
  const f = fixture(new Response(image));
  await f.run(['help']);
  assert.equal(f.uploads.length, 0);
  assert.match(f.edits.at(-1), /获取今日摸鱼日报/);
});

test('moyu rejects images above the pixel budget before upload', async () => {
  const huge = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000"></svg>');
  const f = fixture(new Response(huge, {headers: {'content-type': 'image/svg+xml'}}));
  await f.run();
  assert.equal(f.uploads.length, 0);
  assert.equal(f.deletions.length, 0);
  assert.match(f.edits.at(-1), /获取摸鱼日报失败/);
});

test('moyu awaits an in-flight body cancel before completing abort cleanup', async () => {
  let entered, cancelStarted, releaseCancel;
  const reading = new Promise(resolve => {entered = resolve;});
  const cancelling = new Promise(resolve => {cancelStarted = resolve;});
  const gate = new Promise(resolve => {releaseCancel = resolve;});
  const response = new Response(new ReadableStream({pull() {entered();}, async cancel() {cancelStarted(); await gate;}}));
  const f = fixture(response);
  let finished = false;
  const running = f.run().then(() => {finished = true;});
  await reading;
  f.controller.abort();
  await cancelling;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  releaseCancel();
  await running;
  assert.equal(response.body.locked, false);
  assert.equal(f.uploads.length + f.deletions.length, 0);
  assert.equal(f.edits.length, 1);
});

test('cancellation during upload emits no delete or late failure edit', async () => {
  let started, release;
  const ready = new Promise(resolve => {started = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const f = fixture(new Response(image), {upload: async () => {started(); await gate;}});
  const running = f.run();
  await ready;
  f.controller.abort();
  release();
  await running;
  assert.deepEqual(f.events, ['send']);
  assert.equal(f.deletions.length, 0);
  assert.deepEqual(f.edits, ['开摸...']);
});

test('real Host owns download, upload and delete ordering with no external side effects', async t => {
  const fsPromises = require('node:fs/promises');
  const os = require('node:os');
  const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'telebox-moyu-host-')));
  const events = [], edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch: async () => {
    events.push('download'); return new Response(image, {status: 200, headers: {'content-type': 'image/png'}});
  }}, telegram: {
    async edit(_message, text) {edits.push(text);}, async reply() {assert.fail('unexpected reply');}, async invoke() {}, async getReply() {},
    async withClient(operation, signal) {return operation({
      async sendFile() {events.push('upload');}, async deleteMessages() {events.push('delete');},
    }, signal);},
  }});
  await host.load(create());
  t.after(async () => {assert.equal((await host.shutdown(1000)).completed, true); await fsPromises.rm(root, {recursive: true, force: true});});
  await host.dispatchPrimary({id: 7, chatId: '-100123', senderId: '123', outgoing: true, text: '.moyu', raw: {peerId: {channelId: 123}}, topicId: 9});
  assert.deepEqual(events, ['download', 'upload', 'delete']);
  assert.equal(edits[0], '开摸...');
});

test('real Host unload waits for reader cancellation cleanup before completing', async t => {
  const fsPromises = require('node:fs/promises');
  const os = require('node:os');
  const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'telebox-moyu-reader-')));
  let pulling, cancelStarted, releaseCancel;
  const readReady = new Promise(resolve => {pulling = resolve;});
  const cancelReady = new Promise(resolve => {cancelStarted = resolve;});
  const cancelGate = new Promise(resolve => {releaseCancel = resolve;});
  const uploads = [], edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch: async () => new Response(new ReadableStream({
    pull() {pulling();}, async cancel() {cancelStarted(); await cancelGate;},
  }))}, telegram: {
    async edit(_message, text) {edits.push(text);}, async reply() {}, async invoke() {}, async getReply() {},
    async withClient() {uploads.push(true);},
  }});
  await host.load(create());
  t.after(async () => {await host.shutdown(1000); await fsPromises.rm(root, {recursive: true, force: true});});
  const running = host.dispatchPrimary({id: 7, chatId: '-100123', senderId: '123', outgoing: true, text: '.moyu', raw: {peerId: {channelId: 123}}});
  await readReady;
  let finished = false;
  const unloading = host.unload('moyu', 1000).then(value => {finished = true; return value;});
  await cancelReady;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  releaseCancel();
  assert.equal((await unloading).completed, true);
  await running;
  assert.equal(uploads.length, 0);
  assert.deepEqual(edits, ['开摸...']);
});

test('real Host cancellation during upload waits and performs no subsequent delete', async t => {
  const fsPromises = require('node:fs/promises');
  const os = require('node:os');
  const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'telebox-moyu-upload-')));
  let uploadStarted, releaseUpload;
  const ready = new Promise(resolve => {uploadStarted = resolve;});
  const gate = new Promise(resolve => {releaseUpload = resolve;});
  const events = [], edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch: async () => new Response(image)}, telegram: {
    async edit(_message, text) {edits.push(text);}, async reply() {}, async invoke() {}, async getReply() {},
    async withClient(operation, signal) {return operation({
      async sendFile() {events.push('send'); uploadStarted(); await gate;},
      async deleteMessages() {events.push('delete');},
    }, signal);},
  }});
  await host.load(create());
  t.after(async () => {await host.shutdown(1000); await fsPromises.rm(root, {recursive: true, force: true});});
  const running = host.dispatchPrimary({id: 7, chatId: '-100123', senderId: '123', outgoing: true, text: '.moyu', raw: {peerId: {channelId: 123}}});
  await ready;
  const first = await host.unload('moyu', 5);
  assert.equal(first.completed, false);
  assert.ok(first.pendingTasks > 0);
  releaseUpload();
  await running;
  assert.equal((await host.unload('moyu', 1000)).completed, true);
  assert.deepEqual(events, ['send']);
  assert.deepEqual(edits, ['开摸...']);
});
