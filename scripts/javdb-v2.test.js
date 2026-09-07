'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const {CustomFile, _fileToMedia} = require(path.join(core, 'node_modules/teleproto/client/uploads.js'));
const {load} = require(path.join(core, 'node_modules/cheerio'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {ResourceScope} = require(path.join(core, 'dist/v2/lifecycle.js'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'javdb', packageRoot: path.resolve(__dirname, '../javdb'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64');
const SEARCH = `<div class="movie-list"><div class="item"><a href="/v/abc"><div class="video-title">ABP-123 &lt;title&gt;</div><div class="cover"><img src="https://c0.jdbstatic.com/a.jpg"></div><div class="score"><span class="value">4.5</span></div></a></div></div>`;
const LONG_SEARCH = `<div class="movie-list"><div class="item"><a href="/v/abc"><div class="video-title">ABP-123 &lt;&amp;${'A'.repeat(489)}&#x1F600;</div><div class="cover"><img src="https://c0.jdbstatic.com/a.jpg"></div><div class="score"><span class="value">4.5</span></div></a></div></div>`;
const DETAIL = `<div class="panel-block"><strong>導演</strong><span class="value"><a>&lt;Dir&gt;</a></span></div><div class="panel-block"><strong>演員</strong><span class="value"><a>Alice</a></span></div><div class="panel-block"><strong>類別</strong><span class="value"><a>Tag</a></span></div><div class="score"><span class="value">4.5</span></div>`;
const LONG_DETAIL = `<div class="panel-block"><strong>導演</strong><span class="value"><a>${'D'.repeat(200)}</a></span></div><div class="panel-block"><strong>系列</strong><span class="value"><a>${'S'.repeat(200)}</a></span></div><div class="panel-block"><strong>演員</strong><span class="value">${Array.from({length: 20}, (_, index) => `<a>A${index}${'x'.repeat(60)}</a>`).join('')}</span></div><div class="panel-block"><strong>類別</strong><span class="value">${Array.from({length: 20}, (_, index) => `<a>T${index}${'y'.repeat(60)}</a>`).join('')}</span></div><div class="score"><span class="value">4.5</span></div>`;

async function flush() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-javdb-v2-')));
  const edits = [], sends = [], deletes = [], requests = [], logs = [];
  const transportScope = new ResourceScope();
  let clientActive = false;
  let commandDeletes = 0;
  const raw = {peerId: 7, async delete() {
    commandDeletes += 1;
    if (options.commandDeleteFails) throw new Error('private command delete detail');
  }};
  const client = {
    async sendFile(peer, value) {
      assert.equal(clientActive, true, 'sendFile escaped the transport scope');
      sends.push({peer, value});
      if (options.sendFails) throw new Error('private send detail');
      return {id: options.sentId ?? 88};
    },
    async deleteMessages(...args) {
      assert.equal(clientActive, true, 'deleteMessages escaped the transport scope');
      deletes.push(args);
      if (options.onCoverDelete) await options.onCoverDelete();
      if (options.coverDeleteFails) throw new Error('private cover delete detail');
    },
  };
  const fetch = async (input, init) => {
    const url = new URL(input);
    requests.push({url, init});
    if (options.redirectEscape && url.hostname === 'javdb.com' && url.pathname === '/search') {
      return new Response(null, {status: 302, headers: {location: 'https://evil.example/search'}});
    }
    if (url.hostname === 'javdb.com' && url.pathname === '/search') return new Response(options.search ?? SEARCH);
    if (url.hostname === 'javdb.com' && url.pathname === '/v/abc') return new Response(options.detail ?? DETAIL);
    if (url.hostname === 'c0.jdbstatic.com') {
      if (options.imageFails) throw new Error('private image detail');
      return new Response(JPEG, {headers: {'content-type': 'image/jpeg'}});
    }
    assert.fail(`unexpected network target: ${url.href}`);
  };
  const host = new PluginHost({storageRoot: root, logger: {
    info(event, fields) { logs.push({level: 'info', event, fields}); },
    error(event, fields) { logs.push({level: 'error', event, fields}); },
  }, http: {fetch}, telegram: {
    async edit(message, text, settings, signal) { signal.throwIfAborted(); edits.push({message, text, settings}); },
    async reply() { assert.fail('unexpected reply'); },
    async invoke() { assert.fail('unexpected invoke'); },
    async getReply() { return undefined; },
    async withClient(operation, signal) {
      return transportScope.run('telegram-boundary', async transportSignal => {
        const scopedSignal = AbortSignal.any([signal, transportSignal]);
        scopedSignal.throwIfAborted();
        clientActive = true;
        try { return await operation(client, scopedSignal); }
        finally { clientActive = false; }
      });
    },
  }});
  await host.load(create());
  t.after(async () => {
    const hostReport = await host.shutdown(1000);
    assert.equal(hostReport.completed, true);
    const transportReport = await transportScope.drain(1000);
    assert.equal(transportReport.completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {host, edits, sends, deletes, requests, logs, raw,
    commandDeletes: () => commandDeletes,
    run: text => host.dispatchPrimary({id: 1, chatId: '7', senderId: '1', outgoing: true, text, raw})};
}

test('javdb normalizes codes, escapes details, preserves aliases and sends a short report as the cover caption', async t => {
  const f = await fixture(t);
  await f.run('.av abp 123');
  assert.match(f.requests[0].url.search, /q=ABP-123/);
  assert.equal(f.sends.length, 1);
  assert.match(f.sends[0].value.caption, /&lt;title&gt;[\s\S]*&lt;Dir&gt;[\s\S]*Alice/);
  assert.equal(f.commandDeletes(), 1);
  assert.deepEqual(f.host.listCommands().filter(value => value.pluginId === 'javdb').map(value => value.name), ['av', 'jav', 'javdb', 'jd']);
  assert.ok(f.requests.every(value => value.init.redirect === 'manual'));
});

test('javdb edits the complete long report and sends a bounded, intact cover caption', async t => {
  const success = await fixture(t, {search: LONG_SEARCH, detail: LONG_DETAIL});
  await success.run('.javdb ABP-123');
  const fallback = await fixture(t, {search: LONG_SEARCH, detail: LONG_DETAIL, imageFails: true});
  await fallback.run('.javdb ABP-123');
  const body = success.edits.at(-1).text;
  assert.equal(body, fallback.edits.at(-1).text);
  assert.match(body, /JavDB/);
  assert.ok(load(`<body>${body}</body>`).text().length > 1024);
  const mediaCaption = success.sends[0].value.caption;
  assert.ok(load(`<body>${mediaCaption}</body>`).text().length <= 1024);
  assert.match(mediaCaption, /&lt;&amp;/);
  assert.doesNotMatch(mediaCaption, /[\uD800-\uDBFF]$/u);
  assert.doesNotMatch(mediaCaption, /&[^;]*$/u);
  assert.equal(success.commandDeletes(), 0);
});

test('javdb deletes the cover once at 60 seconds and not at 59 seconds', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = await fixture(t);
  await f.run('.av ABP-123');
  t.mock.timers.tick(59_000);
  await flush();
  assert.equal(f.deletes.length, 0);
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(f.deletes.length, 1);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.deletes.length, 1);
});

test('javdb unload cancels cover cleanup with no pending task or later transport call', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = await fixture(t);
  await f.run('.av ABP-123');
  const report = await f.host.unload('javdb', 1000);
  assert.equal(report.completed, true);
  assert.equal(report.pendingTasks, 0);
  assert.equal(report.pendingResources, 0);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.deletes.length, 0);
});

test('javdb keeps an expiring deletion inside both resource scopes during unload', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let beginDelete;
  const started = new Promise(resolve => { beginDelete = resolve; });
  let releaseDelete;
  const blocked = new Promise(resolve => { releaseDelete = resolve; });
  const f = await fixture(t, {onCoverDelete: () => { beginDelete(); return blocked; }});
  await f.run('.av ABP-123');
  t.mock.timers.tick(60_000);
  await started;
  let unloaded = false;
  const unloading = f.host.unload('javdb', 1000).then(report => { unloaded = true; return report; });
  await flush();
  assert.equal(unloaded, false);
  releaseDelete();
  const report = await unloading;
  assert.equal(report.completed, true);
  assert.equal(report.pendingTasks, 0);
  assert.equal(f.deletes.length, 1);
});

test('javdb retains cover cleanup when command deletion fails', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = await fixture(t, {commandDeleteFails: true});
  await f.run('.av ABP-123');
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.deletes.length, 1);
});

test('javdb reports a sanitized cover deletion failure', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = await fixture(t, {coverDeleteFails: true});
  await f.run('.av ABP-123');
  t.mock.timers.tick(60_000);
  await flush();
  const entry = f.logs.find(value => value.event === 'javdb_delete_cover_failed');
  assert.ok(entry);
  assert.doesNotMatch(JSON.stringify(entry), /private cover delete detail/);
});

test('teleproto 1.229 constructs a spoiler InputMediaUploadedPhoto from an uploaded JPEG', async () => {
  assert.equal(JPEG.subarray(0, 2).toString('hex'), 'ffd8');
  assert.equal(JPEG.subarray(-2).toString('hex'), 'ffd9');
  const parts = [];
  const client = {session: {dcId: 2}, _media: {
    opts: {upload: {maxSessions: 1, maxWindow: 512 * 1024}},
    async savePart(dcId, request, signal) { signal.throwIfAborted(); parts.push({dcId, request}); },
  }};
  const result = await _fileToMedia(client, {file: new CustomFile('cover.jpg', JPEG.length, '', JPEG), spoiler: true});
  assert.equal(parts.length, 1);
  assert.ok(result.media instanceof Api.InputMediaUploadedPhoto);
  assert.equal(result.media.spoiler, true);
});

test('javdb falls back to the complete text when cover download fails', async t => {
  const f = await fixture(t, {imageFails: true});
  await f.run('.javdb ABP-123');
  assert.equal(f.sends.length, 0);
  assert.match(f.edits.at(-1).text, /JavDB/);
  assert.doesNotMatch(f.edits.at(-1).text, /private/);
});

test('javdb blocks redirect escapes and exposes only the generic failure', async t => {
  const f = await fixture(t, {redirectEscape: true});
  await f.run('.javdb ABP-123');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url.hostname, 'javdb.com');
  assert.equal(f.sends.length, 0);
  assert.match(f.edits.at(-1).text, /查询失败/);
});

test('javdb rejects malformed codes before network access', async t => {
  const f = await fixture(t);
  await f.run('.jd ../../etc/passwd');
  assert.equal(f.requests.length, 0);
  assert.match(f.edits.at(-1).text, /格式无效/);
});
