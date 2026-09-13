'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {Api, utils} = require(path.join(core, 'node_modules/teleproto'));
const {returnBigInt: integer} = require(path.join(core, 'node_modules/teleproto/Helpers.js'));
const packageRoot = path.resolve(__dirname, '../cosplay');

function artifact() {
  return buildPlugin({id: 'cosplay', packageRoot, entry: 'v2.ts'}).artifactDir;
}

function createPlugin() {
  const directory = artifact();
  delete require.cache[require.resolve(path.join(directory, 'index.cjs'))];
  return require(path.join(directory, 'index.cjs')).default();
}

function internals(source) {
  const filename = path.join(artifact(), 'index.cjs');
  const candidate = new Module(filename);
  candidate.filename = filename;
  candidate.paths = Module._nodeModulePaths(path.dirname(filename));
  candidate._compile(`${fsSync.readFileSync(filename, 'utf8')}\n${source}`, filename);
  return candidate.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}

async function within(promise, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function htmlResponse(html) {
  return new Response(html, {status: 200, headers: {'content-type': 'text/html; charset=utf-8'}});
}

function imageResponse(bytes = [0xff, 0xd8, 0xff, 0xd9]) {
  return new Response(Uint8Array.from(bytes), {status: 200, headers: {'content-type': 'image/jpeg'}});
}

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cosplay-v2-')));
  const edits = [], logs = [], sends = [], uploads = [], wire = [];
  let listingCalls = 0, uploadId = 0;
  const fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname === '/' || url.pathname.startsWith('/page/')) {
      listingCalls++;
      if (listingCalls <= (options.listingFailures ?? 0)) return new Response('retry', {status: 503});
      return htmlResponse('<a href="https://cosplaytele.com/set-one/">set</a>');
    }
    if (url.pathname === '/set-one/') return htmlResponse([
      '<figure class="gallery-item"><img src="https://cosplaytele.com/media/a.jpg"></figure>',
      '<figure class="gallery-item"><img src="https://cosplaytele.com/media/b.jpg"></figure>',
    ].join(''));
    if (url.pathname === '/media/b.jpg' && options.failSecondImage) {
      return new Response('not an image', {status: 200, headers: {'content-type': 'text/plain'}});
    }
    if (url.pathname.startsWith('/media/')) return imageResponse();
    throw new Error(`unexpected URL ${url.href}`);
  };
  const peer = new Api.PeerUser({userId: integer(42)});
  const client = {
    async getInputEntity(value) {
      if (value instanceof Api.InputPeerUser) return value;
      if (value instanceof Api.PeerUser) return new Api.InputPeerUser({userId: value.userId, accessHash: integer(77)});
      return value;
    },
    async uploadFile(payload) {
      uploads.push(payload);
      uploadId++;
      return new Api.InputFile({id: integer(uploadId), parts: 1, name: `upload-${uploadId}.jpg`, md5Checksum: ''});
    },
    async invoke(request) {
      await request.resolve(client, utils);
      const bytes = request.getBytes();
      wire.push({request, bytes});
      if (request instanceof Api.messages.UploadMedia) {
        const index = wire.filter(item => item.request instanceof Api.messages.UploadMedia).length;
        return new Api.MessageMediaPhoto({photo: new Api.Photo({
          id: integer(100 + index), accessHash: integer(200 + index), fileReference: Buffer.alloc(0),
          date: 0, sizes: [], dcId: 1,
        })});
      }
      if (request instanceof Api.messages.SendMultiMedia && options.failAlbum) {
        const error = new Error('BOT_TOKEN=should-not-leak');
        error.name = 'sk-live-should-not-leak/etc/passwd';
        throw error;
      }
      return {};
    },
    async sendFile(target, payload) {sends.push({target, payload});},
  };
  const host = new PluginHost({storageRoot: root, tempRoot: path.join(root, 'temp'), prefixes: ['🙂'],
    logger: {info(event) {logs.push(['info', event]);}, error(event) {logs.push(['error', event]);}},
    http: {fetch}, telegram: {
      async edit(_message, text) {edits.push(text);}, async reply() {}, async invoke() {}, async getReply() {},
      async withClient(operation, signal) {return operation(client, signal);},
    }});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  await host.load(createPlugin());
  const raw = {peerId: peer, async delete() {
    if (options.deleteFailure) {
      const error = new Error('BOT_TOKEN=delete-secret'); error.name = 'sk-live-delete-secret/etc/passwd'; throw error;
    }
  }};
  return {
    root, host, edits, logs, sends, uploads, wire, listingCalls: () => listingCalls,
    run(count = '2') {
      const suffix = count === '' ? '' : ` ${count}`;
      return host.dispatchPrimary({id: 9, chatId: '42', senderId: '42', outgoing: true,
        text: `🙂cos${suffix}`, raw});
    },
  };
}

test('cosplay keeps strict count validation before HTTP work', async t => {
  const f = await fixture(t);
  for (const value of ['0', '11', '1.5', 'nope']) await f.run(value);
  assert.equal(f.listingCalls(), 0);
  assert.equal(f.edits.length, 4);
  assert.ok(f.edits.every(text => /1 到 10 的整数/.test(text)));
});

test('cosplay preserves an exact peer when no raw Telegram message is available', () => {
  const {targetForTest: target} = internals('module.exports.targetForTest=target;');
  const peer = target({message: {chatId: '9007199254740993'}});
  assert.equal(peer.value, 9007199254740993n);
});

test('cosplay sends multiple images as one spoiler album with complete progress', async t => {
  const f = await fixture(t, {deleteFailure: true});
  assert.equal(await f.run('2'), true);
  const uploads = f.wire.filter(item => item.request instanceof Api.messages.UploadMedia);
  const albums = f.wire.filter(item => item.request instanceof Api.messages.SendMultiMedia);
  assert.equal(uploads.length, 2);
  assert.equal(albums.length, 1);
  assert.ok(f.wire.every(item => item.bytes.length > 0));
  assert.equal(f.sends.length, 0);
  assert.equal(albums[0].request.multiMedia.length, 2);
  assert.ok(albums[0].request.multiMedia.every(item => item.media.spoiler === true));
  assert.deepEqual(albums[0].request.multiMedia.map(item => item.message), ['套图链接: https://cosplaytele.com/set-one/', '']);
  assert.deepEqual(f.edits, [
    '正在从随机套图中获取 2 张图片…',
    '从套图"set one"中找到 2 张图片，正在下载…',
    '下载完成，正在发送…',
  ]);
  assert.deepEqual(f.logs, [['info', 'cosplay_receipt_cleanup_failed']]);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'temp', 'cosplay')), []);
});

test('cosplay falls back to spoiler singles only after an album failure', async t => {
  const f = await fixture(t, {failAlbum: true});
  await f.run('2');
  assert.equal(f.wire.some(item => item.request instanceof Api.messages.SendMultiMedia), true);
  assert.equal(f.sends.length, 2);
  assert.ok(f.sends.every(item => item.payload.spoiler === true));
  assert.ok(f.sends.every(item => item.payload.caption === '套图链接: https://cosplaytele.com/set-one/'));
  assert.deepEqual(f.logs, [['error', 'cosplay_album_failed']]);
  assert.equal(JSON.stringify({edits: f.edits, logs: f.logs}).includes('should-not-leak'), false);
  assert.doesNotMatch(f.edits.at(-1), /获取 Cosplay 图片失败/);
});

test('cosplay retries discovery and sends successful downloads when another image fails', async t => {
  const f = await fixture(t, {listingFailures: 1, failSecondImage: true});
  await f.run('2');
  assert.equal(f.listingCalls(), 2);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].payload.spoiler, true);
  assert.deepEqual(f.logs, [['error', 'cosplay_download_failed']]);
  assert.equal(f.edits.includes('下载完成，正在发送…'), true);
  assert.doesNotMatch(f.edits.at(-1), /获取 Cosplay 图片失败/);
});

test('cosplay writeAll handles short writes and stops before a post-cancel write', async () => {
  const {writeAllForTest: writeAll} = internals('module.exports.writeAllForTest=writeAll;');
  const source = Uint8Array.from([1, 2, 3, 4, 5]), written = [], calls = [];
  const handle = {async write(buffer, offset, length) {
    calls.push({offset, length});
    const count = Math.min(2, length);
    written.push(...buffer.subarray(offset, offset + count));
    return {bytesWritten: count};
  }};
  await writeAll(handle, source, new AbortController().signal);
  assert.deepEqual(written, [...source]);
  assert.deepEqual(calls, [{offset: 0, length: 5}, {offset: 2, length: 3}, {offset: 4, length: 1}]);

  const entered = deferred(), release = deferred(), controller = new AbortController();
  let cancelledCalls = 0;
  const blocked = writeAll({async write() {
    cancelledCalls++;
    entered.resolve();
    await release.promise;
    return {bytesWritten: 1};
  }}, Uint8Array.from([7, 8]), controller.signal);
  await within(entered.promise);
  controller.abort(new Error('cancelled'));
  release.resolve();
  await assert.rejects(blocked);
  assert.equal(cancelledCalls, 1);
});

test('cosplay closes the file handle even when earlier reader cleanup fails', async () => {
  const {closeDownloadForTest: closeDownload} = internals('module.exports.closeDownloadForTest=closeDownload;');
  let closed = 0;
  await assert.rejects(closeDownload({async close() {throw new Error('reader cleanup failed');}}, {
    async close() {closed++;},
  }), /reader cleanup failed/);
  assert.equal(closed, 1);
});

test('real host unload actively cancels and releases a hung HTTP reader', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cosplay-cancel-v2-')));
  const entered = deferred(), release = deferred();
  let locked = false, cancelled = 0, released = 0;
  const reader = {
    async read() {entered.resolve(); return release.promise;},
    async cancel() {cancelled++; release.resolve({done: true});},
    releaseLock() {released++; locked = false;},
  };
  const body = {
    get locked() {return locked;},
    getReader() {locked = true; return reader;},
    async cancel() {cancelled++;},
  };
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}},
    http: {fetch: async () => ({status: 200, headers: new Headers({'content-type': 'text/html'}), body})},
    telegram: {async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {assert.fail('no Telegram send expected');}}});
  t.after(async () => {
    release.resolve({done: true});
    await host.shutdown(1000);
    await fs.rm(root, {recursive: true, force: true});
  });
  await host.load(createPlugin());
  const work = host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text: '.cos', raw: {}});
  await within(entered.promise);
  const report = await host.unload('cosplay', 200);
  if (!report.completed) release.resolve({done: true});
  await within(Promise.allSettled([work]));
  assert.equal(report.completed, true);
  assert.ok(cancelled >= 1);
  assert.equal(released, 1);
});
