'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'diss', packageRoot: path.resolve(__dirname, '../diss'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('diss returns escaped bounded text', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-diss-v2-')));
  const edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {
    fetch: async () => new Response('<bad & text>', {status: 200}),
  }, telegram: {async edit(m, text, options) {edits.push({text, options});}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {}}});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  await host.dispatchPrimary({id: 1, chatId: 'chat', senderId: 'owner', outgoing: true, text: '.diss'});
  assert.equal(edits.at(-1).text, '&lt;bad &amp; text&gt;');
  assert.equal(edits.at(-1).options.parseMode, 'html');
});

function direct(fetchResponse) {
  const controller = new AbortController();
  const edits = [];
  let requests = 0;
  const ctx = {
    signal: controller.signal,
    http: {async withResponse(url, init, consume, options) {
      requests++;
      assert.equal(options.timeoutMs, 10000);
      assert.equal(new URL(url).searchParams.get('c'), '1009');
      return consume(await fetchResponse(requests), controller.signal);
    }},
    telegram: {async edit(_, text) {edits.push(text);}},
  };
  return {controller, edits, requests: () => requests, ctx,
    run: (args = []) => create().commands.diss.handle({
      args, command: 'diss', prefix: '.',
      message: {id: 1, chatId: '1', text: '.diss', outgoing: true},
    }, ctx)};
}

test('diss retries service failures and returns the first successful quote', async () => {
  const f = direct(n => n === 1 ? new Response('service error', {status: 503}) : new Response(' usable '));
  await f.run();
  assert.equal(f.requests(), 2);
  assert.equal(f.edits.at(-1), 'usable');
});

test('diss stops after five failed requests', async () => {
  const f = direct(() => {throw new Error('private transport detail');});
  await f.run();
  assert.equal(f.requests(), 5);
  assert.equal(f.edits.at(-1), '语录获取失败，请稍后重试');
  assert.equal(f.edits.length, 2);
});

test('diss cancellation interrupts retry delay without another request or edit', async () => {
  let received;
  const responseReceived = new Promise(resolve => {received = resolve;});
  const f = direct(() => {received(); return new Response('', {status: 503});});
  const running = f.run();
  await responseReceived;
  // Let the failed HTTP request reach the abortable delay.
  await new Promise(resolve => setImmediate(resolve));
  f.controller.abort();
  await running;
  assert.equal(f.requests(), 1);
  assert.equal(f.edits.length, 1);
});

test('diss cancellation releases a stalled response reader', async () => {
  let reading, canceled = 0;
  const started = new Promise(resolve => {reading = resolve;});
  const response = new Response(new ReadableStream({
    pull() {reading();},
    cancel() {canceled++;},
  }));
  const f = direct(() => response);
  const running = f.run();
  await started;
  await new Promise(resolve => setImmediate(resolve));
  f.controller.abort();
  await running;
  assert.equal(canceled, 1);
  assert.equal(response.body.locked, false);
  assert.equal(f.edits.length, 1);
});

test('diss bounds oversized streams, retries empty and invalid UTF-8 responses', async () => {
  let canceled = 0;
  const oversized = new Response(new ReadableStream({
    start(target) {target.enqueue(new Uint8Array(16 * 1024 + 1));},
    cancel() {canceled++;},
  }));
  const responses = [oversized, new Response('  '), new Response(new Uint8Array([0xff])), new Response('valid')];
  const f = direct(n => responses[n - 1]);
  await f.run();
  assert.equal(f.requests(), 4);
  assert.equal(canceled, 1);
  assert.equal(oversized.body.locked, false);
  assert.equal(f.edits.at(-1), 'valid');
});

test('diss help stays local and Telegram failures do not retry HTTP', async () => {
  const help = direct(() => assert.fail('unexpected HTTP'));
  await help.run(['help']);
  assert.equal(help.requests(), 0);
  const f = direct(() => new Response('quote'));
  let edits = 0;
  f.ctx.telegram.edit = async () => {if (++edits === 2) throw new Error('Telegram failure');};
  await f.run();
  assert.equal(f.requests(), 1);
});
