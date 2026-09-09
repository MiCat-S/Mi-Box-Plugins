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

const CONCURRENCY = 6;

function servers(count, {online = count, longNames = false} = {}) {
  return Array.from({length: count}, (_, index) => ({
    id: index + 1,
    name: longNames ? `node-${String(index + 1).padStart(3, '0')}-${'测'.repeat(40)}` : `node-${index + 1}`,
    last_active: index < online ? new Date().toISOString() : new Date(0).toISOString(),
    host: {mem_total: 1024, disk_total: 2048},
    state: {cpu: 1, mem_used: 10, disk_used: 20, net_out_speed: 0, net_in_speed: 0, uptime: 0},
  }));
}

async function fixture(t, {data, serviceMonitor = false, serviceFetch, replyFails = false} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-nezha-list-')));
  await fs.mkdir(path.join(root, 'nezha'));
  await fs.writeFile(path.join(root, 'nezha/config-v2.json'),
    JSON.stringify({schemaVersion: 1, url: 'https://panel.invalid/base', secret: 'fixture-secret', serviceMonitor, legacyImported: true}));
  const edits = [], replies = [], requests = [];
  const host = new PluginHost({
    storageRoot: root, tempRoot: path.join(root, 'temp'), logger: {info() {}, error() {}},
    telegram: {
      async edit(_m, text) {edits.push(text);},
      async reply(_m, text) {if (replyFails) throw new Error('PAGE_DELIVERY_FAILED'); replies.push(text);},
      async invoke() {assert.fail('unexpected RPC');}, async getReply() {}, async withClient(fn, signal) {return fn({}, signal);},
    },
    http: {fetch: async (url, init) => {
      const target = new URL(url);
      requests.push(target.pathname);
      if (target.pathname.endsWith('/api/v1/server')) return Response.json({success: true, data});
      if (serviceFetch) return serviceFetch(target, init);
      return Response.json({success: true, data: []});
    }},
  });
  await host.load(create());
  t.after(async () => {await host.shutdown(2000); await fs.rm(root, {recursive: true, force: true});});
  return {
    edits, replies, requests,
    run: () => host.dispatchPrimary({id: 9, chatId: '123', senderId: '123', outgoing: true, text: '.nezha', raw: {peerId: '123'}}),
    unload: () => host.unload('nezha', 2000),
  };
}

function balanced(html) {
  const stack = [];
  for (const match of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (match[1]) { if (stack.pop() !== match[2]) return false; }
    else if (!match[0].endsWith('/>')) stack.push(match[2]);
  }
  return stack.length === 0;
}

test('nezha paginates every node instead of slicing the joined html', async t => {
  const data = servers(180, {online: 0, longNames: true});
  const f = await fixture(t, {data});
  await f.run();
  const pages = f.replies.length ? [f.edits.at(-1), ...f.replies] : [f.edits.at(-1)];
  const output = pages.join('\n');
  assert.ok(pages.length > 1, `expected multiple pages, got ${pages.length}`);
  assert.doesNotMatch(output, /slice|截断/);
  for (const page of pages) {
    assert.ok(page.length <= 3500, `page exceeds budget: ${page.length}`);
    assert.ok(balanced(page), `unbalanced tags: ${page.slice(0, 80)}`);
  }
  // Every node must survive exactly once, not just the first and last.
  for (const server of data) assert.equal(output.split(`#${server.id}<`).length - 1, 1, `node ${server.id}`);
  assert.ok(pages[0].endsWith(`1/${pages.length} 页`));
});

test('nezha keeps the published first page when a later page fails', async t => {
  const data = servers(180, {online: 0, longNames: true});
  const f = await fixture(t, {data, replyFails: true});
  await f.run();
  assert.match(f.edits.at(-1), /#1</);
  assert.doesNotMatch(f.edits.at(-1), /PAGE_DELIVERY_FAILED/);
  assert.equal(f.replies.length, 0);
});

test('nezha bounds service fan-out while still querying every online node', async t => {
  const data = servers(80);
  let active = 0, peak = 0, serviceRequests = 0;
  const f = await fixture(t, {data, serviceMonitor: true, serviceFetch: async () => {
    serviceRequests += 1; active += 1; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
    return Response.json({success: true, data: []});
  }});
  await f.run();
  assert.equal(serviceRequests, 80);
  assert.ok(peak <= CONCURRENCY, `peak concurrency ${peak} exceeded ${CONCURRENCY}`);
  assert.ok(peak > 1, 'expected some overlap to prove the limit is not serial');
});

test('nezha stops starting service requests after the command is aborted', async t => {
  const data = servers(80);
  const started = [];
  const f = await fixture(t, {data, serviceMonitor: true, serviceFetch: (_target, init) => new Promise((_resolve, reject) => {
    started.push(1);
    init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true});
  })});
  const command = f.run();
  while (started.length < CONCURRENCY) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.unload()).completed, true);
  await command;
  assert.ok(started.length <= CONCURRENCY + 1, `started ${started.length} requests after abort`);
  assert.ok(started.length < 80, 'abort must prevent the remaining fan-out');
});
