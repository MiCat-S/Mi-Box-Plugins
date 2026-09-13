'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const sharp = require(path.join(core, 'node_modules/sharp'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const built = buildPlugin({id: 'koutu', packageRoot: path.resolve(__dirname, '../koutu'), entry: 'v2.ts'});
const {default: create, responseBytes} = require(path.join(built.artifactDir, 'index.cjs'));

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-koutu-')));
  const png = await sharp({create: {width: 8, height: 8, channels: 4, background: '#ff000080'}}).png().toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  const edits = [], sent = [], requests = [], logs = [], responses = [], targets = [];
  let downloads = 0;
  const raw = {media: {}, photo: {}, id: 5};
  const reply = options.reply === false ? undefined : {id: 5, text: '', raw};
  const client = {
    async *iterDownload() {downloads++; yield options.input || png;},
    async downloadProfilePhoto(target) {targets.push(target); return png;},
    async sendFile(peer, value) {sent.push({peer, ...value});},
  };
  const host = new PluginHost({storageRoot: path.join(root, 'assets'), tempRoot: path.join(root, 'temp'),
    logger: {info(event) {logs.push(event);}, error(event) {logs.push(event);}},
    http: {fetch: async (url, init) => {
      requests.push({url: String(url), init});
      const response = options.respond ? await options.respond(requests.length, webp, init) : new Response(webp, {headers: {'content-type': 'image/webp'}});
      responses.push(response); return response;
    }},
    telegram: {async edit(_message, text) {edits.push(text);}, async reply() {}, async invoke() {throw new Error('unexpected RPC');},
      async getReply() {return reply;}, async withClient(use, signal) {return use(client, signal);}},
  });
  await host.load(create());
  t.after(async () => {await host.shutdown(2000); await fs.rm(root, {recursive: true, force: true});});
  const run = (text, extra = {}) => host.dispatchPrimary({id: 1, text, chatId: '1', senderId: '1', outgoing: true,
    raw: {peerId: 'peer', async delete() {if (options.cleanupFails) throw new Error('private failure');}}, topicId: 9, ...extra});
  const configure = () => run('.koutu set key test-key', {saved: true});
  return {host, root, png, webp, raw, reply, run, configure, edits, sent, requests, logs, responses, targets, get downloads() {return downloads;}};
}

test('koutu restricts key commands, masks settings and routes help without API calls', async t => {
  const f = await fixture(t);
  await f.run('.koutu set key private-key'); assert.match(f.edits.at(-1), /收藏夹/);
  await f.configure(); assert.doesNotMatch(f.edits.at(-1), /test-key/);
  const settings = await f.host.readSettings('koutu');
  assert.equal(settings.secretSet.apiKey, true); assert.equal(settings.values.apiKey, undefined);
  await f.run('.koutu help'); assert.match(f.edits.at(-1), /picupapi/);
  await f.run('.koutu typo'); assert.equal(f.requests.length, 0);
});

test('koutu sends transparent WebP in the reply topic and cleanup failure is not a business failure', async t => {
  const f = await fixture(t, {cleanupFails: true}); await f.configure(); await f.run('.koutu');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].init.headers.apikey, 'test-key');
  assert.match(f.requests[0].url, /^https:\/\/picupapi.tukeli.net\/api\/v1\/matting\?/);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].replyTo, 5); assert.equal(f.sent[0].topMsgId, 9);
  assert.equal((await sharp(f.sent[0].file.buffer).metadata()).hasAlpha, true);
  assert.ok(f.logs.includes('koutu_receipt_cleanup_failed'));
  assert.ok(!f.logs.includes('koutu_failed')); assert.ok(f.responses.every(value => !value.body.locked));
  assert.deepEqual(await fs.readdir(path.join(f.root, 'temp', 'koutu')), []);
});

test('koutu retries type rejection exactly once as PNG and hides provider errors', async t => {
  const f = await fixture(t, {respond: (index, output, init) => {
    const file = init.body.get('file');
    assert.equal(file.type, index === 1 ? 'image/webp' : 'image/png');
    return index === 1 ? new Response('{"code":5013}', {headers: {'content-type': 'application/json'}})
      : new Response(output, {headers: {'content-type': 'image/webp'}});
  }});
  await f.configure(); await f.run('.koutu'); assert.equal(f.requests.length, 2); assert.equal(f.sent.length, 1);
  const bad = await fixture(t, {respond: () => new Response('private-key-error', {status: 403})});
  await bad.configure(); await bad.run('.koutu'); assert.equal(bad.sent.length, 0);
  assert.doesNotMatch(bad.edits.join(' '), /private-key-error/);
});

test('koutu rejects TGS, oversized media and oversized pixels before HTTP', async t => {
  for (const scenario of ['tgs', 'size', 'pixels']) {
    const f = await fixture(t, {input: scenario === 'pixels' ? Buffer.from('<svg width="5000" height="5000" xmlns="http://www.w3.org/2000/svg"/>') : undefined});
    if (scenario !== 'pixels') f.raw.document = {size: scenario === 'size' ? 20971521n : 1n,
      mimeType: scenario === 'tgs' ? 'application/x-tgsticker' : 'image/png'};
    await f.configure(); await f.run('.koutu'); assert.equal(f.requests.length, 0); assert.equal(f.sent.length, 0);
    if (scenario !== 'pixels') assert.equal(f.downloads, 0);
  }
});

test('koutu uses self avatar without a reply and sender input entity for text replies', async t => {
  const f = await fixture(t, {reply: false}); await f.configure(); await f.run('.koutu');
  assert.equal(f.targets[0].className, 'InputPeerSelf'); assert.equal(f.sent.length, 1);
  const g = await fixture(t); delete g.raw.photo; delete g.raw.media;
  g.raw.getInputSender = async () => 'exact-sender-peer';
  await g.configure(); await g.run('.koutu'); assert.equal(g.targets[0], 'exact-sender-peer');
});

test('koutu response consumer releases the reader on cancellation and byte overflow', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({pull() {}, cancel() {cancelled = true;}}));
  const pending = responseBytes(response, controller.signal); controller.abort();
  await assert.rejects(pending); assert.equal(response.body.locked, false); assert.equal(cancelled, true);
  const large = new Response(new Uint8Array(20971521));
  await assert.rejects(responseBytes(large, new AbortController().signal), /20 MiB/);
  assert.equal(large.body.locked, false);
});

test('koutu video extraction checks dimensions, file-only protocols and bounded output', async () => {
  const {videoFrame} = require(path.join(built.artifactDir, 'index.cjs'));
  const calls = [];
  const signal = new AbortController().signal;
  const ctx = {processes: {async run(binary, args, options) {
    calls.push({binary, args, options});
    return {stdout: Buffer.from('{"streams":[{"width":1920,"height":1080}]}')};
  }}};
  await videoFrame(ctx, '/tmp/work/input.mp4', '/tmp/work/frame.png', '/tmp/work', signal);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf('-protocol_whitelist') + 1], 'file');
    assert.equal(call.options.cwd, '/tmp/work');
  }
  const args = calls[1].args;
  assert.equal(args[args.indexOf('-fs') + 1], '20971520');
  assert.equal(args[args.indexOf('-frames:v') + 1], '1');
  let count = 0;
  await assert.rejects(videoFrame({processes: {async run() {count++; return {stdout: Buffer.from('{"streams":[{"width":10000,"height":10000}]}')};}}},
    'input', 'output', '/tmp', signal), /像素/);
  assert.equal(count, 1);
});

test('koutu handles GIF and generic MIME image documents', async t => {
  const gif = await sharp({create: {width: 4, height: 4, channels: 4, background: '#ffffff'}}).gif().toBuffer();
  const f = await fixture(t, {input: gif});
  f.raw.document = {size: BigInt(gif.length), mimeType: 'application/octet-stream', attributes: [{fileName: 'photo.gif'}]};
  await f.configure(); await f.run('.koutu'); assert.equal(f.sent.length, 1);
});

test('koutu unload cancels HTTP, prevents late sends and drains the temporary directory', async t => {
  let ready;
  const started = new Promise(resolve => {ready = resolve;});
  const f = await fixture(t, {respond: async (_index, _output, init) => {
    ready();
    await new Promise((resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true});
    });
  }});
  await f.configure();
  const pending = f.run('.koutu'); await started;
  await f.run('.koutu', {chatId: '2'}); assert.match(f.edits.at(-1), /已有抠图任务/);
  const report = await f.host.unload('koutu', 2000); await pending;
  assert.equal(report.completed, true); assert.equal(f.sent.length, 0);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'temp', 'koutu')), []);
});
