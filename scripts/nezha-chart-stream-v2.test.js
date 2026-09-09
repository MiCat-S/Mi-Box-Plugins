'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const built = buildPlugin({id: 'nezha', packageRoot: path.resolve(__dirname, '../nezha'), entry: 'v2.ts'});
const create = require(path.join(built.artifactDir, 'index.cjs')).default;
const png = Buffer.from('89504e470d0a1a0a0102030405060708', 'hex');
const monitor = [{monitor_id: 1, server_id: 7, monitor_name: 'HTTPS', server_name: 'Node A', created_at: [1000, 2000], avg_delay: [12, 34]}];

async function fixture(t, chartResponse) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-nezha-stream-')));
  await fs.mkdir(path.join(root, 'nezha'));
  await fs.writeFile(path.join(root, 'nezha/config-v2.json'), JSON.stringify({schemaVersion: 1, url: 'https://panel.invalid/base', secret: 'fixture-secret', serviceMonitor: true, legacyImported: true}));
  const edits = [], sent = [], requests = [];
  const host = new PluginHost({storageRoot: root, tempRoot: path.join(root, 'temp'), logger: {info() {}, error() {}},
    telegram: {async edit(_m, text) {edits.push(text);}, async reply() {}, async invoke() {assert.fail('unexpected RPC');}, async getReply() {},
      async withClient(fn, signal) {return fn({async sendFile(peer, options) {
        sent.push({peer, options, bytes: await fs.readFile(options.file)});
      }}, signal);}},
    http: {fetch: async (url, init) => {
      const target = new URL(url); requests.push({url: target.href, init});
      if (target.hostname === 'panel.invalid') return Response.json({success: true, data: target.pathname.endsWith('/server') ? [{id: 7, name: 'Node A'}] : monitor});
      assert.equal(target.href, 'https://quickchart.io/chart');
      return chartResponse ? chartResponse({root, init}) : new Response(png);
    }},
  });
  await host.load(create());
  t.after(async () => {assert.equal((await host.shutdown(2000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  return {root, host, edits, sent, requests,
    run: () => host.dispatchPrimary({id: 9, chatId: '123', senderId: '123', outgoing: true, text: '.nezha chart 7', raw: {peerId: '123'}}),
    async cleaned() {let jobs;try {jobs = await fs.readdir(path.join(root, 'temp/nezha'));} catch (e) {if (e.code === 'ENOENT') return; throw e;}assert.deepEqual(jobs, []);},
  };
}

async function chartPath(root) {
  const directory = path.join(root, 'temp/nezha');
  const jobs = await fs.readdir(directory); assert.equal(jobs.length, 1);
  return path.join(directory, jobs[0], 'chart.png');
}

test('nezha writes chart chunks before the response ends and preserves bytes and chart options', async t => {
  let pulls = 0;
  const f = await fixture(t, ({root}) => new Response(new ReadableStream({async pull(controller) {
    if (pulls++ === 0) {controller.enqueue(png.subarray(0, 8)); return;}
    if (pulls === 2) {
      assert.deepEqual(await fs.readFile(await chartPath(root)), png.subarray(0, 8));
      controller.enqueue(png.subarray(8)); return;
    }
    controller.close();
  }}, {highWaterMark: 0})));
  await f.run(); assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0].bytes, png);
  assert.equal(f.sent[0].peer, '123'); assert.equal(f.sent[0].options.caption, 'Node A 服务延迟'); assert.equal(f.sent[0].options.replyTo, 9);
  assert.deepEqual(f.requests.map(x => new URL(x.url).pathname), ['/base/api/v1/server', '/base/api/v1/service/7', '/chart']);
  const request = f.requests.at(-1); assert.equal(request.init.method, 'POST');
  const body = JSON.parse(request.init.body); assert.equal(body.width, 800); assert.equal(body.height, 400); assert.equal(body.backgroundColor, 'black'); assert.equal(body.format, 'png');
  assert.equal(body.chart.type, 'line'); assert.equal(body.chart.data.datasets[0].label, 'HTTPS'); assert.deepEqual(body.chart.data.datasets[0].data, [12, 34]);
  await f.cleaned();
});

test('nezha accepts a four MiB chart', async t => {
  let remaining = 4 * 1024 * 1024;
  const f = await fixture(t, () => new Response(new ReadableStream({pull(controller) {
    if (!remaining) {controller.close(); return;}
    const chunk = new Uint8Array(Math.min(64 * 1024, remaining)); remaining -= chunk.length; controller.enqueue(chunk);
  }})));
  await f.run(); assert.equal(f.sent[0].bytes.length, 4 * 1024 * 1024); await f.cleaned();
});

test('nezha rejects an oversized chart and cancels the remaining response', async t => {
  let remaining = 4 * 1024 * 1024 + 1, cancelled = false;
  const f = await fixture(t, () => new Response(new ReadableStream({pull(controller) {
    if (!remaining) return;
    const chunk = new Uint8Array(Math.min(64 * 1024, remaining)); remaining -= chunk.length; controller.enqueue(chunk);
  }, cancel() {cancelled = true;}}, {highWaterMark: 0})));
  await f.run(); assert.equal(f.sent.length, 0); assert.equal(cancelled, true); await f.cleaned();
});

for (const failure of ['status', 'read']) {
  test(`nezha cleans chart files on HTTP ${failure} failure`, async t => {
    const f = await fixture(t, () => failure === 'status' ? new Response('unavailable', {status: 503}) : new Response(new ReadableStream({pull(controller) {controller.error(new Error('broken stream'));}})));
    await f.run(); assert.equal(f.sent.length, 0); assert.match(f.edits.at(-1), /❌/); await f.cleaned();
  });
}

test('nezha closes a chart file after a write failure', async t => {
  const originalOpen = fs.open; let closed = false, cancelled = false;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (!String(file).endsWith('/chart.png')) return handle;
    return {async writeFile() {throw new Error('disk write failed');}, async close() {closed = true; await handle.close();}};
  });
  const f = await fixture(t, () => new Response(new ReadableStream({pull(controller) {controller.enqueue(png);}, cancel() {cancelled = true;}}, {highWaterMark: 0})));
  await f.run(); assert.equal(closed, true); assert.equal(cancelled, true); assert.equal(f.sent.length, 0); await f.cleaned();
});

test('nezha unload cancels an in-progress chart response and removes its file', async t => {
  let ready; const started = new Promise(resolve => {ready = resolve;}); let cancelled = false;
  const f = await fixture(t, ({init}) => new Response(new ReadableStream({start(controller) {
    init.signal.addEventListener('abort', () => {cancelled = true; controller.error(init.signal.reason);}, {once: true}); ready();
  }})));
  const command = f.run(); await started;
  assert.equal((await f.host.unload('nezha', 2000)).completed, true);
  await command; assert.equal(cancelled, true); assert.equal(f.sent.length, 0); await f.cleaned();
});
