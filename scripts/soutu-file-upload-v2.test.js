'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const built = buildPlugin({id: 'soutu', packageRoot: path.resolve(__dirname, '../soutu'), entry: 'v2.ts'});
const create = require(path.join(built.artifactDir, 'index.cjs')).default;

async function fixture(t, {bytes = Buffer.from('ffd8ffe000104a464946', 'hex'), download, upload} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-soutu-file-')));
  const edits = [], events = [], requests = [], targets = [];
  const raw = {photo: {}, async downloadMedia(options) {
    assert.equal(typeof options.outputFile, 'string');
    assert.ok(options.signal instanceof AbortSignal);
    targets.push(options.outputFile); events.push('download');
    if (download) return download(options);
    await fs.writeFile(options.outputFile, bytes);
    await options.progressCallback(BigInt(bytes.length));
    return options.outputFile;
  }};
  const host = new PluginHost({storageRoot: root, tempRoot: path.join(root, 'temp'), logger: {info() {}, error() {}},
    telegram: {async edit(_m, text, options) {edits.push({text, options}); events.push(text.includes('正在下载') ? 'progress' : 'result');},
      async reply() {}, async invoke() {assert.fail('unexpected RPC');}, async getReply() {return {raw};},
      async withClient(fn, signal) {return fn({}, signal);}},
    http: {fetch: async (url, init) => {
      events.push('upload'); requests.push({url: String(url), init});
      assert.equal((await fs.stat(targets.at(-1))).isFile(), true);
      return upload ? upload(url, init) : new Response('https://0x0.st/fixture.jpg\n');
    }},
  });
  await host.load(create());
  t.after(async () => {assert.equal((await host.shutdown(2000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  return {host, edits, events, requests, targets,
    run: () => host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, replyToId: 2, text: '.soutu'}),
    async cleaned() {for (const file of targets) await assert.rejects(fs.stat(path.dirname(file)), {code: 'ENOENT'});},
  };
}

for (const [name, hex] of [['photo.jpg', 'ffd8ffe000104a464946'], ['photo.png', '89504e470d0a1a0a'], ['photo.gif', '474946383961'], ['photo.webp', '524946460000000057454250'], ['photo.jpg', '01']]) {
  test(`soutu preserves ${name} bytes and multipart metadata (${hex})`, async t => {
    const bytes = Buffer.from(hex, 'hex');
    const f = await fixture(t, {bytes, upload: async (_url, init) => {
      assert.ok(init.body instanceof FormData);
      const file = init.body.get('file');
      assert.equal(file.name, name); assert.equal(file.type, '');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
      assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'omit');
      assert.equal(new Headers(init.headers).get('user-agent'), 'MiBot-Soutu/2.0');
      return new Response('https://0x0.st/test.png\n');
    }});
    await f.run();
    assert.deepEqual(f.events, ['progress', 'download', 'upload', 'result']);
    assert.match(f.edits.at(-1).text, /Google Lens/); assert.match(f.edits.at(-1).text, /Yandex Images/);
    assert.equal(f.edits.at(-1).options.linkPreview, false); await f.cleaned();
  });
}

test('soutu accepts the 20 MiB boundary using a file-backed multipart body', async t => {
  const f = await fixture(t, {download: async ({outputFile, progressCallback}) => {
    const file = await fs.open(outputFile, 'w');
    try {await file.truncate(20 * 1024 * 1024);} finally {await file.close();}
    await progressCallback(20n * 1024n * 1024n);
    return outputFile;
  }, upload: async (_url, init) => {
    assert.equal(init.body.get('file').size, 20 * 1024 * 1024);
    return new Response('https://0x0.st/boundary.jpg');
  }});
  await f.run(); assert.equal(f.requests.length, 1); await f.cleaned();
});

for (const size of [0, 20 * 1024 * 1024 + 1]) {
  test(`soutu rejects a ${size}-byte file before upload`, async t => {
    const f = await fixture(t, {download: async ({outputFile}) => {
      const file = await fs.open(outputFile, 'w');
      try {await file.truncate(size);} finally {await file.close();}
      return outputFile;
    }});
    await f.run(); assert.equal(f.requests.length, 0); assert.match(f.edits.at(-1).text, /搜图失败/); await f.cleaned();
  });
}

test('soutu stops an oversized download at the progress callback', async t => {
  const f = await fixture(t, {download: async ({outputFile, progressCallback}) => {
    await fs.writeFile(outputFile, 'partial');
    await assert.rejects(progressCallback(20n * 1024n * 1024n + 1n), /Invalid image/);
    throw new Error('download stopped');
  }});
  await f.run(); assert.equal(f.requests.length, 0); await f.cleaned();
});

test('soutu cleans partial downloads and failed uploads', async t => {
  for (const stage of ['download', 'upload']) {
    const f = await fixture(t, stage === 'download' ? {download: async ({outputFile}) => {
      await fs.writeFile(outputFile, 'partial'); throw new Error('download failed');
    }} : {upload: async () => {throw new Error('upload failed');}});
    await f.run(); assert.match(f.edits.at(-1).text, /搜图失败/); await f.cleaned();
  }
});

test('soutu unload cancels upload and cleans the temporary file after settlement', async t => {
  let started;
  const ready = new Promise(resolve => {started = resolve;});
  const f = await fixture(t, {upload: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true}); started();
  })});
  const command = f.run(); await ready;
  assert.equal((await f.host.unload('soutu', 2000)).completed, true);
  await command; await f.cleaned(); assert.equal(f.edits.length, 1);
});

test('soutu unload cancels a partial download before upload', async t => {
  let started;
  const ready = new Promise(resolve => {started = resolve;});
  const f = await fixture(t, {download: async ({outputFile, signal}) => {
    await fs.writeFile(outputFile, 'partial');
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once: true}); started();
    });
  }});
  const command = f.run(); await ready;
  assert.equal((await f.host.unload('soutu', 2000)).completed, true);
  await command; await f.cleaned(); assert.equal(f.requests.length, 0); assert.equal(f.edits.length, 1);
});

test('soutu keeps the file available when an allowed redirect replays the upload', async t => {
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const f = await fixture(t, {bytes, upload: async (url, init) => {
    assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()), bytes);
    return new URL(url).pathname === '/'
      ? new Response(null, {status: 307, headers: {location: '/upload'}})
      : new Response('https://0x0.st/redirect.png');
  }});
  await f.run(); assert.equal(f.requests.length, 2); assert.match(f.edits.at(-1).text, /Google Lens/); await f.cleaned();
});
