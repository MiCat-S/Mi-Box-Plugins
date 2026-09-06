'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'dig', packageRoot: path.resolve(__dirname, '../dig'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
async function fixture(t, result = '93.184.216.34\n', http = {async withResponse() {throw new Error('offline');}}) {
  const edits = [], calls = [], controller = new AbortController();
  const ctx = {signal: controller.signal, http, telegram: {
    async edit(message, text, options) {edits.push({message, text, options});}, async reply(message, text, options) {edits.push({message, text, options});},
    async invoke() {assert.fail('unexpected invoke');}, async getReply() {return undefined;}, async withClient() {assert.fail('unexpected native call');},
  }, processes: {async run(command, args, options) {
    calls.push({command, args, options});
    if (typeof result === 'function') return result(controller);
    return {stdout: Buffer.from(result)};
  }}};
  return {edits, calls, controller, run: text => create().commands.dig.handle({
    args: text.split(/\s+/).slice(1), command: 'dig', prefix: '.',
    message: {id: 1, chatId: '1', senderId: '1', outgoing: true, text},
  }, ctx)};
}
test('dig validates arguments and passes argv without shell', async t => {
  const f = await fixture(t);
  await f.run('.dig example.com MX');
  assert.match(f.edits.at(-1).text, /DNS 查询结果[\s\S]*example\.com[\s\S]*MX/);
  assert.deepEqual(f.calls[0], {command: '/usr/bin/dig', args: ['example.com', 'MX', '+short'],
    options: {timeoutMs: 10000, maxOutputBytes: 32768}});
});
test('dig rejects injection and unsupported types before process admission', async t => {
  const f = await fixture(t);
  await f.run('.dig example.com;rm -rf /');
  await f.run('.dig example.com ANY');
  assert.match(f.edits.at(-1).text, /记录类型不支持/);
  assert.equal(f.calls.length, 0);
});

test('dig supports SRV records and IPv6 DNS servers with exact argv', async t => {
  const f = await fixture(t);
  await f.run('.dig _sip._tcp.example.com SRV @2001:4860:4860::8888');
  assert.deepEqual(f.calls[0].args, ['@2001:4860:4860::8888', '_sip._tcp.example.com', 'SRV', '+short']);
  await f.run('.dig 1.0.0.127.in-addr.arpa PTR');
  assert.equal(f.calls.length, 2);
});

test('dig rejects invalid IP octets and option-like servers before execution', async t => {
  const f = await fixture(t);
  for (const server of ['999.1.1.1', '-bad.example', '::invalid', 'a..example']) {
    await f.run(`.dig example.com A ${server}`);
    assert.match(f.edits.at(-1).text, /DNS 服务器格式无效/);
  }
  assert.equal(f.calls.length, 0);
});
test('dig help is local', async t => {
  const f = await fixture(t);
  await f.run('.dig help');
  assert.match(f.edits[0].text, /DNS 查询/);
});

test('dig retains TTL and detailed answers with requested flags', async t => {
  const f = await fixture(t, 'example.com. 300 IN MX 10 mail.example.com.\n');
  await f.run('.dig example.com MX +noall +answer');
  assert.deepEqual(f.calls[0].args, ['example.com', 'MX', '+noall', '+answer']);
  assert.match(f.edits.at(-1).text, /300 IN MX 10 mail\.example\.com/);
});

test('dig pages every record without splitting Unicode or escaped entities', async t => {
  const output = Array.from({length: 50}, (_, i) => `${i} "<&😀${'x'.repeat(150)}"`).join('\n');
  const f = await fixture(t, output);
  await f.run('.dig example.com TXT');
  const pages = f.edits.slice(1).map(item => item.text);
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= 3500));
  const content = pages.map(page => page.match(/<pre>([\s\S]*)<\/pre>/)[1]).join('');
  assert.equal(content, output.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]));
});

test('dig rejects unsupported options before process execution', async t => {
  const f = await fixture(t);
  await f.run('.dig example.com +trace');
  assert.equal(f.calls.length, 0);
  assert.match(f.edits.at(-1).text, /查询选项不支持/);
});

test('dig accepts an explicit server before or after the domain with default A', async t => {
  const f = await fixture(t);
  await f.run('.dig @1.1.1.1 example.com');
  await f.run('.dig example.com @1.1.1.1');
  for (const call of f.calls) assert.deepEqual(call.args, ['@1.1.1.1', 'example.com', 'A', '+short']);
  assert.equal(f.calls.length, 2);
});

test('dig rejects empty or conflicting servers', async t => {
  const f = await fixture(t);
  for (const text of ['.dig example.com @', '.dig @1.1.1.1 example.com @8.8.8.8',
    '.dig example.com A 1.1.1.1 @8.8.8.8']) await f.run(text);
  assert.equal(f.calls.length, 0);
});

test('dig escapes process failures and does not report success', async t => {
  const f = await fixture(t, () => {throw new Error('failed <&>');});
  await f.run('.dig example.com');
  assert.equal(f.edits.length, 2);
  assert.match(f.edits[1].text, /DNS 查询失败[\s\S]*failed &lt;&amp;&gt;/);
});

test('dig does not start after cancellation or send results after unload', async t => {
  const before = await fixture(t);
  before.controller.abort();
  await before.run('.dig example.com');
  assert.equal(before.calls.length, 0);
  assert.equal(before.edits.length, 0);
  const during = await fixture(t, controller => {
    controller.abort();
    return {stdout: Buffer.from('1.1.1.1')};
  });
  await during.run('.dig example.com');
  assert.equal(during.calls.length, 1);
  assert.equal(during.edits.length, 1);
  assert.equal(during.edits[0].text, '正在查询 DNS…');
});

test('dig renders location and ASN as escaped text alongside the original answer', async t => {
  const f = await fixture(t, 'example.com. 300 IN A 1.1.1.1\n', {
    async withResponse(url, init, consume) {
      return consume(Response.json({country: '<b>&country</b>', asn: 13335}), new AbortController().signal);
    }
  });
  await f.run('.dig example.com A +noall +answer');
  assert.match(f.edits.at(-1).text, /example\.com\. 300 IN A 1\.1\.1\.1\n  &lt;b&gt;&amp;country&lt;\/b&gt; · AS13335/);
  assert.equal(f.edits.at(-1).options.parseMode, 'html');
});
