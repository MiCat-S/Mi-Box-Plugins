'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'oxost', packageRoot: path.resolve(__dirname, '../oxost'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-upload-')));
  const edits = [], requests = [], downloads = [];
  const raw = {media: {}, document: {size: 8, attributes: [{fileName: 'report.pdf'}], ...options.document},
    ...(options.raw ?? {}),
    async downloadMedia(params) {
      downloads.push(params);
      if (options.download) return options.download(params);
      if (params?.outputFile) { await fs.writeFile(params.outputFile, 'document'); return params.outputFile; }
      return Buffer.from('document');
    }};
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}},
    http: {fetch: async (url, init) => {
      requests.push({url, init});
      if (options.fetch) return options.fetch(url, init, downloads.at(-1));
      return new Response('https://0x0.st/report.pdf');
    }}, telegram: {
      async edit(_message, text) { edits.push(text); }, async reply() {}, async invoke() {},
      async getReply() { return {raw}; },
      async withClient(operation, signal) { return operation({}, signal); },
    }});
  await host.load(create());
  t.after(async () => { assert.equal((await host.shutdown(1000)).completed, true); await fs.rm(root, {recursive: true, force: true}); });
  return {host, root, requests, downloads, edits,
    run: () => host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, replyToId: 2, text: '.0x0 expires=72 secret'})};
}

test('oxost uploads a file-backed blob and retains the temporary file through response consumption', async t => {
  let file;
  const f = await fixture(t, {fetch: async (_url, init, download) => {
    assert.equal(typeof download.outputFile, 'string');
    assert.ok(download.signal instanceof AbortSignal);
    file = download.outputFile;
    const blob = init.body.get('file');
    assert.equal(blob.size, 8);
    assert.equal(blob.name, 'report.pdf');
    assert.equal(await blob.text(), 'document');
    assert.equal(init.body.get('expires'), '72');
    assert.equal(init.body.get('secret'), '1');
    return new Response(new ReadableStream({async start(controller) {
      assert.equal((await fs.stat(file)).size, 8);
      controller.enqueue(new TextEncoder().encode('https://0x0.st/report.pdf'));
      controller.close();
    }}));
  }});
  await f.run();
  assert.match(f.edits.at(-1), /https:\/\/0x0.st\/report.pdf/);
  await assert.rejects(fs.stat(file), {code: 'ENOENT'});
});

test('oxost rejects announced oversized files before downloading', async t => {
  const f = await fixture(t, {document: {size: 100 * 1024 * 1024 + 1}});
  await f.run();
  assert.equal(f.downloads.length, 0);
  assert.equal(f.requests.length, 0);
  assert.match(f.edits.at(-1), /上传失败/);
});

test('oxost enforces transferred bytes while downloading, then removes partial files', async t => {
  let file;
  const f = await fixture(t, {download: async params => {
    assert.equal(typeof params?.progressCallback, 'function');
    file = params.outputFile;
    await fs.writeFile(file, 'partial');
    params.progressCallback({greater: limit => 100 * 1024 * 1024 + 1 > limit});
    assert.fail('oversized transfer must stop');
  }});
  await f.run();
  assert.equal(f.requests.length, 0);
  assert.match(f.edits.at(-1), /上传失败/);
  await assert.rejects(fs.stat(file), {code: 'ENOENT'});
});

test('oxost unload aborts a pending download without posting a partial file', async t => {
  let started, release = () => {}, file;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, {download: async params => {
    if (params?.outputFile) { file = params.outputFile; await fs.writeFile(file, 'partial'); }
    return new Promise(resolve => {
      release = () => resolve(params?.outputFile ?? Buffer.from('partial'));
      params?.signal.addEventListener('abort', release, {once: true});
      started();
    });
  }});
  const running = f.run();
  await ready;
  try {
    assert.equal((await f.host.unload('oxost', 500)).completed, true);
    await running;
    assert.equal(f.requests.length, 0);
    assert.equal(f.edits.length, 1);
    await assert.rejects(fs.stat(file), {code: 'ENOENT'});
  } finally { release(); await running; }
});

test('oxost file transfer integrates with the actual Teleproto document downloader', async t => {
  const {Api} = require(path.join(core, 'node_modules/teleproto'));
  const {returnBigInt} = require(path.join(core, 'node_modules/teleproto/Helpers'));
  const {downloadMedia} = require(path.join(core, 'node_modules/teleproto/client/downloads'));
  const document = new Api.Document({id: returnBigInt(1), accessHash: returnBigInt(2), fileReference: Buffer.alloc(0),
    date: 0, mimeType: 'application/pdf', size: returnBigInt(8), dcId: 1, attributes: []});
  const remote = {session: {dcId: 1}, _media: {
    opts: {partSize: 128 * 1024, download: {maxSessions: 1, maxWindow: 128 * 1024}},
    async getFile(_dc, _location, _offset, _size, signal) { signal.throwIfAborted(); return Buffer.from('document'); },
  }};
  const f = await fixture(t, {
    download: params => downloadMedia(remote, document, params.outputFile, undefined, params.progressCallback, {signal: params.signal}),
    fetch: async (_url, init) => {
      assert.equal(await init.body.get('file').text(), 'document');
      return new Response('https://0x0.st/report.pdf');
    },
  });
  await f.run();
  assert.match(f.edits.at(-1), /https:\/\/0x0.st\/report.pdf/);
  assert.equal(f.requests.length, 1);
  await assert.rejects(fs.stat(f.downloads[0].outputFile), {code: 'ENOENT'});
});

test('oxost failed HTTP upload closes the file lifetime and keeps diagnostics private', async t => {
  const f = await fixture(t, {fetch: async () => { throw new Error('private-upload-diagnostic'); }});
  await f.run();
  assert.match(f.edits.at(-1), /上传失败/);
  assert.doesNotMatch(f.edits.join(''), /private-upload-diagnostic/);
  await assert.rejects(fs.stat(f.downloads[0].outputFile), {code: 'ENOENT'});
});

test('oxost accepts the exact 100 MiB announced size and a missing size', async t => {
  for (const document of [{size: 100 * 1024 * 1024}, {size: undefined}]) {
    const f = await fixture(t, {document, fetch: async () => new Response('https://0x0.st/ok')});
    await f.run();
    assert.match(f.edits.at(-1), /0x0\.st\/ok/, JSON.stringify(document));
    assert.equal(f.requests.length, 1);
  }
});

test('oxost derives photo file names from a 12-byte header', async t => {
  const cases = [['ffd8ff', 'photo.jpg'], ['89504e47', 'photo.png'], ['47494638', 'photo.gif'],
    ['52494646' + '00000000' + '57454250', 'photo.webp']];
  for (const [magic, name] of cases) {
    const header = Buffer.from(magic.padEnd(24, '0'), 'hex').subarray(0, 12);
    const f = await fixture(t, {document: {attributes: []}, raw: {photo: true},
      download: async params => { await fs.writeFile(params.outputFile, header); return params.outputFile; },
      fetch: async (_url, init) => { assert.equal(init.body.get('file').name, name); return new Response('https://0x0.st/photo'); }});
    await f.run();
    assert.match(f.edits.at(-1), /0x0\.st\/photo/, name);
  }
});

test('oxost unload during upload response consumption cleans the temporary file', async t => {
  let started, file;
  const ready = new Promise(resolve => {started = resolve;});
  const f = await fixture(t, {fetch: async (_url, _init, download) => {
    file = download.outputFile;
    return new Response(new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode('https://0x0.st/'));
      started();
    }}));
  }});
  const running = f.run();
  await ready;
  assert.equal((await f.host.unload('oxost', 1000)).completed, true);
  await running;
  assert.equal(f.edits.length, 1);
  await assert.rejects(fs.stat(file), {code: 'ENOENT'});
});
