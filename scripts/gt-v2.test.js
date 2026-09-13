'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {definePlugin} = require(path.join(core, 'dist/v2/sdk.js'));
const {artifactDir} = buildPlugin({id: 'gt', packageRoot: path.resolve(__dirname, '../gt'), entry: 'v2.ts'});
const createGt = require(path.join(artifactDir, 'index.cjs')).default;
const envelope = {id: 1, chatId: '9007199254740993', senderId: '123', outgoing: true, text: '.gt Hello'};

async function fixture(t, {translate = async () => 'translated', reply, ai = true, onEdit, onReply} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-gt-v2-')));
  const edits = [], replies = [], requests = [], logs = [];
  const host = new PluginHost({storageRoot: root, logger: {
    info(event, fields) { logs.push({level: 'info', event, fields}); },
    error(event, fields) { logs.push({level: 'error', event, fields}); },
  }, telegram: {
    async edit(message, text, options, signal) { edits.push({message, text, options, signal}); await onEdit?.(edits.length, text); },
    async reply(message, text, options, signal) { replies.push({message, text, options, signal}); await onReply?.(replies.length, text); },
    async getReply() { return reply && {...envelope, text: reply, id: 2}; },
    async withClient() { assert.fail('unexpected native call'); },
    async invoke() { assert.fail('unexpected RPC'); },
  }});
  if (ai) await host.load(definePlugin({apiVersion: 1, id: 'ai', description: 'fixture', commands: {}, services: {
    translate: {description: 'fixture', handle(input, _context, signal) {
      requests.push({input, signal});
      return translate(input, signal);
    }},
  }}));
  await host.load(createGt());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {host, edits, replies, requests, logs, run: text => host.dispatchPrimary({...envelope, text})};
}

test('v2 gt help needs no provider and discloses model API costs', async t => {
  const {run, edits, requests} = await fixture(t, {ai: false});
  await run('.gt HELP');
  assert.match(edits[0].text, /AI 翻译/);
  assert.match(edits[0].text, /调用费用/);
  assert.equal(requests.length, 0);
});

test('v2 gt preserves paragraphs, target selection, message IDs and escaping', async t => {
  const {run, edits, requests} = await fixture(t, {translate: async () => '<你好>&'});
  await run('.gt Hello\n\nworld');
  assert.deepEqual(requests[0].input, {text: 'Hello\n\nworld', target: 'zh-CN'});
  assert.match(edits.at(-1).text, /&lt;你好&gt;&amp;/);
  assert.equal(edits.at(-1).message.chatId, envelope.chatId);
  await run('.gt\tEN\t你好\n世界');
  assert.deepEqual(requests[1].input, {text: '你好\n世界', target: 'en'});
});

test('v2 gt reply translation retains content and rejects absent or overlong text', async t => {
  const withReply = await fixture(t, {reply: '你好\n世界'});
  await withReply.run('.gt EN');
  assert.deepEqual(withReply.requests[0].input, {text: '你好\n世界', target: 'en'});
  const empty = await fixture(t);
  await empty.run('.gt');
  assert.match(empty.edits.at(-1).text, /请提供/);
  assert.equal(empty.edits.at(-1).options.parseMode, 'html');
  await empty.run('.gt ' + 'a'.repeat(5001));
  assert.match(empty.edits.at(-1).text, /5000/);
  assert.equal(empty.edits.at(-1).options.parseMode, 'html');
  assert.equal(empty.requests.length, 0);
});

test('v2 gt reports missing providers without a request', async t => {
  const {run, edits, requests} = await fixture(t, {ai: false});
  await run('.gt Hello');
  assert.match(edits.at(-1).text, /安装或更新配套 ai/);
  assert.equal(edits.at(-1).options.parseMode, 'html');
  assert.equal(requests.length, 0);
});

test('v2 gt streams output chunks without breaking surrogate pairs or losing text', async t => {
  const translated = 'a'.repeat(2999) + '😀' + 'b'.repeat(3500);
  const {run, edits, replies} = await fixture(t, {translate: async () => translated});
  await run('.gt Hello');
  const chunks = [edits.at(-1).text.split('<b>译文:</b>\n')[1], ...replies.map(value => value.text)];
  assert.equal(chunks.join(''), translated);
  assert.ok(chunks.every(chunk => chunk.length <= 3000));
  assert.equal(chunks[1].startsWith('😀'), true);
});

test('v2 gt bounds pages after HTML escaping while preserving every code point', async t => {
  const translated = '<&😀'.repeat(1800);
  const {run, edits, replies} = await fixture(t, {translate: async () => translated});
  await run('.gt source');
  const output = [edits.at(-1).text.split('<b>译文:</b>\n')[1], ...replies.map(value => value.text)];
  assert.ok(output.length > 1);
  assert.ok(output.every(page => page.length <= 3000));
  assert.equal(output.join(''), translated.replaceAll('&', '&amp;').replaceAll('<', '&lt;'));
  assert.ok(output.every(page => !/[\uD800-\uDBFF]$/.test(page) && !/^[\uDC00-\uDFFF]/.test(page)));
});

test('v2 gt keeps the first translated page when a later page delivery fails', async t => {
  const secret = 'telegram secret token';
  const translated = 'a'.repeat(7000);
  const f = await fixture(t, {translate: async () => translated, onReply(count) {
    if (count === 1) throw new Error(secret);
  }});
  await f.run('.gt source');
  assert.equal(f.requests.length, 1);
  assert.match(f.edits.at(-1).text, /AI 翻译结果/);
  assert.doesNotMatch(f.edits.at(-1).text, /AI 翻译失败/);
  assert.ok(f.logs.some(item => item.event === 'gt_delivery_interrupted' && item.fields.published === 1));
  assert.match(f.replies.at(-1).text, /已发送 1\/3 页/);
  assert.equal(JSON.stringify({edits: f.edits, replies: f.replies, logs: f.logs}).includes(secret), false);
});

test('v2 gt sanitizes provider failures and invalid output', async t => {
  for (const translate of [async () => { throw new Error('secret-api-key'); }, async () => ' ', async () => ({secret: 'secret-api-key'})]) {
    const {run, edits} = await fixture(t, {translate});
    await run('.gt Hello');
    assert.match(edits.at(-1).text, /AI 翻译失败/);
    assert.equal(edits.at(-1).options.parseMode, 'html');
    assert.doesNotMatch(JSON.stringify(edits), /secret-api-key/);
  }
});

test('v2 gt unload cancels the provider and suppresses late translation output', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const {run, host, edits, requests} = await fixture(t, {translate: (_input, signal) => new Promise(resolve => {
    started();
    signal.addEventListener('abort', () => resolve('late'), {once: true});
  })});
  const running = run('.gt Hello');
  await ready;
  assert.equal((await host.unload('gt')).completed, true);
  await running;
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(edits.length, 1);
});

test('v2 gt command respects owner admission and edited message policy', async t => {
  const {host, requests} = await fixture(t);
  assert.equal(await host.dispatchPrimary({...envelope, outgoing: false}), false);
  assert.equal(await host.dispatchPrimary({...envelope, edited: true}), false);
  assert.equal(requests.length, 0);
});
