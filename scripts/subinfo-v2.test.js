'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'subinfo', packageRoot: path.resolve(__dirname, '../subinfo'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('subinfo decodes subscription and counts protocols', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-subinfo-v2-')));
  const edits = [];
  const payload = Buffer.from('vmess://one\ntrojan://two\nss://three\n').toString('base64');
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch: async () => new Response(payload, {status: 200})},
    telegram: {async edit(m, text, options) {edits.push({text, options});}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {}}});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  await host.dispatchPrimary({id: 1, chatId: 'chat', senderId: 'owner', outgoing: true, text: '.subinfo https://example.com/sub'});
  assert.match(edits.at(-1).text, /节点总数: 3/);
  assert.match(edits.at(-1).text, /vmess: 1/);
  assert.match(edits.at(-1).text, /trojan: 1/);
  assert.match(edits.at(-1).text, /节点列表/);
});

test('subinfo accepts a replied subscription URL and reports regions', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-subinfo-reply-')));
  const edits = [];
  const payload = Buffer.from('ss://x#香港节点\ntrojan://x#Tokyo-1').toString('base64');
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch: async () => new Response(payload)},
    telegram: {async edit(m, text, options) {edits.push({text, options});}, async reply() {}, async invoke() {}, async getReply() {return {id: 2, chatId: 'chat', text: '订阅 https://example.com/sub'};}, async withClient() {}}});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  await host.dispatchPrimary({id: 1, chatId: 'chat', senderId: 'owner', outgoing: true, text: '.subinfo'});
  assert.match(edits.at(-1).text, /节点总数: 2/);
  assert.match(edits.at(-1).text, /香港: 1/);
  assert.match(edits.at(-1).text, /Tokyo-1/);
});

async function inspect(payload) {
  const pages = [];
  const emit = async (_, text) => pages.push(text);
  await create().commands.subinfo.handle({
    args: ['https://example.com/sub'], message: {id: 1, chatId: '1'},
  }, {signal: new AbortController().signal, http: {async withResponse(url, init, consume) {
    return consume(new Response(payload), new AbortController().signal);
  }},
    telegram: {edit: emit, reply: emit}});
  return pages.slice(1);
}

test('subinfo extracts VMess and SSR remarks without displaying encoded credentials', async () => {
  const secret = 'private-password-do-not-display';
  const vmess = Buffer.from(JSON.stringify({ps: 'Tokyo <&>', id: secret, add: 'private.example'})).toString('base64');
  const anonymous = Buffer.from(JSON.stringify({id: secret})).toString('base64');
  const ssr = Buffer.from(`private.example:443:origin:aes-256-cfb:plain:${secret}/?remarks=${Buffer.from('香港 SSR').toString('base64url')}`).toString('base64url');
  const pages = await inspect(`vmess://${vmess}\nvmess://${anonymous}\nssr://${ssr}\nss://${Buffer.from(secret).toString('base64')}`);
  const text = pages.join('');
  assert.match(text, /Tokyo &lt;&amp;&gt;/);
  assert.match(text, /VMESS 2/);
  assert.match(text, /香港 SSR/);
  assert.match(text, /SS 4/);
  for (const value of [secret, anonymous, vmess, ssr, 'private.example']) assert.ok(!text.includes(value));
});

test('subinfo classifies decoded names rather than credentials or substrings', async () => {
  const text = (await inspect('trojan://us-password@hk.example#Australia\nss://jp-password@de.example#business\nvless://x#%E9%A6%99%E6%B8%AF\nss://x#broken%ZZ')).join('');
  assert.match(text, /澳大利亚: 1/);
  assert.match(text, /香港: 1/);
  assert.match(text, /其他: 2/);
  assert.doesNotMatch(text, /美国:|日本:|德国:/);
  assert.match(text, /broken%ZZ/);
});

test('subinfo paginates every node and preserves escaped Unicode names', async () => {
  const names = Array.from({length: 65}, (_, i) => `${i} <&😀${'x'.repeat(100)}`);
  const pages = await inspect(names.map(name => `ss://secret#${encodeURIComponent(name)}`).join('\n'));
  assert.ok(pages.length > 1);
  assert.ok(pages.every(text => text.length <= 3500));
  const content = pages.map(text => [...text.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].at(-1)[1]).join('');
  assert.equal(content, names.map((name, i) => `${i + 1}. ${name}`).join('\n').replace(/[&<>"]/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;'})[c]));
});

test('subinfo parses Clash YAML names and protocols without exposing configuration fields', async () => {
  const text = (await inspect(`proxies:
  - name: "香港 <&> 01"
    type: ss
    server: private.example
    password: secret-password
  - name: Tokyo
    type: trojan
    password: other-secret
  - type: vless
    uuid: secret-uuid
`)).join('');
  assert.match(text, /节点总数: 3/);
  assert.match(text, /ss: 1\ntrojan: 1\nvless: 1/);
  assert.match(text, /香港 &lt;&amp;&gt; 01/);
  assert.match(text, /VLESS 3/);
  assert.match(text, /日本: 1/);
  assert.doesNotMatch(text, /private\.example|secret-password|other-secret|secret-uuid/);
});

test('subinfo accepts JSON Clash configuration and counts safe unfamiliar protocols', async () => {
  const text = (await inspect(JSON.stringify({proxies: [
    {type: 'anytls', name: 'SG-1', password: 'secret'}, {type: 'constructor', name: 'test'},
  ]}))).join('');
  assert.match(text, /节点总数: 2/);
  assert.match(text, /anytls: 1\nconstructor: 1/);
  assert.match(text, /新加坡: 1/);
  assert.doesNotMatch(text, /secret/);
});

test('subinfo rejects malformed Clash nodes without dumping their contents', async () => {
  for (const payload of ['proxies: secret', 'proxies: [null]', 'proxies: [{type: {password: secret}}]',
    'proxies: [{type: "ss<script>"}]', 'proxies: [']) {
    assert.deepEqual(await inspect(payload), ['订阅读取或解析失败，请稍后重试']);
  }
});

test('subinfo supports remaining legacy URI protocol families', async () => {
  const protocols = ['hy', 'socks5', 'http', 'https', 'shadowtls', 'naive'];
  const text = (await inspect(protocols.map(p => `${p}://secret@private.example`).join('\n'))).join('');
  assert.match(text, /节点总数: 6/);
  for (const protocol of protocols) assert.ok(text.includes(`${protocol}: 1`));
  assert.doesNotMatch(text, /secret|private\.example/);
});

test('subinfo reports bounded traffic and expiry information from subscription headers', async () => {
  const pages = [];
  const now = Date.now();
  await create().commands.subinfo.handle({
    args: ['https://example.com/sub'], message: {id: 1, chatId: '1'},
  }, {signal: new AbortController().signal, http: {async withResponse(url, init, consume) {
    const response = new Response('ss://x#node', {headers: {
      'subscription-userinfo': `upload=1024; download=2048; total=4096; expire=${Math.floor((now + 86400000) / 1000)}`
    }});
    return consume(response, new AbortController().signal);
  }}, telegram: {async edit(_, text) {pages.push(text);}, async reply(_, text) {pages.push(text);}}});
  assert.match(pages.at(-1), /上传: 1\.00 KiB/);
  assert.match(pages.at(-1), /已用: 3\.00 KiB/);
  assert.match(pages.at(-1), /剩余: 1\.00 KiB/);
  assert.match(pages.at(-1), /到期:/);
});

test('subinfo distinguishes missing, unlimited and invalid traffic fields', async () => {
  const {trafficSummary} = require(path.join(artifactDir, 'index.cjs'));
  assert.match(trafficSummary(null), /未提供/);
  assert.match(trafficSummary('upload=1;download=2;total=0;expire=0'), /未设限/);
  assert.match(trafficSummary('expire=99999999999999999999'), /无效时间/);
});
