'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'aitc', packageRoot: path.resolve(__dirname, '../aitc'), entry: 'v2.ts'});
const createAitc = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t, response = {choices: [{message: {content: 'translated'}}]}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-aitc-v2-')));
  const edits = [], requests = [];
  let reply;
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch: async (url, init) => {
    requests.push({url: new URL(url), init});
    return Response.json(response);
  }}, telegram: {
    async edit(message, text, options) { edits.push({message, text, options}); },
    async reply() { assert.fail('unexpected reply'); },
    async invoke() { assert.fail('unexpected invoke'); },
    async getReply() { return reply; },
    async withClient() { assert.fail('unexpected native call'); },
  }});
  await host.load(createAitc());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {
    host, edits, requests, setReply(value) { reply = value; },
    run: (text, message = {}) => host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text, ...message}),
  };
}

test('aitc accepts API keys only from Saved Messages and never displays them', async t => {
  const f = await fixture(t);
  await f.run('.aitc key sk-secret-value');
  assert.match(f.edits.at(-1).text, /仅限在收藏夹/);
  await f.run('.aitc key sk-secret-value', {saved: true});
  assert.match(f.edits.at(-1).text, /已更新/);
  await f.run('.aitc info');
  assert.match(f.edits.at(-1).text, /API Key：已配置/);
  assert.doesNotMatch(f.edits.map(item => item.text).join('\n'), /sk-secret-value/);
});

test('aitc persists configuration and sends an OpenAI-compatible request', async t => {
  const f = await fixture(t);
  await f.run('.aitc key sk-test', {saved: true});
  await f.run('.aitc url https://api.example.test/base');
  await f.run('.aitc model example-model');
  await f.run('.aitc temp 0.7');
  await f.run('.aitc spn casual Use a casual voice');
  await f.run('.aitc casual 你好');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url.href, 'https://api.example.test/base/v1/chat/completions');
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(f.requests[0].init.body);
  assert.equal(body.model, 'example-model');
  assert.equal(body.temperature, 0.7);
  assert.equal(body.messages[0].content, 'Use a casual voice');
  assert.equal(body.messages[1].content, '你好');
  assert.equal(f.edits.at(-1).text, 'translated');
  assert.equal(f.edits.at(-1).options.parseMode, undefined);
});

test('aitc uses replied text when no arguments are supplied', async t => {
  const f = await fixture(t, {choices: [{message: {content: 'reply result'}}]});
  await f.run('.aitc key sk-test', {saved: true});
  f.setReply({text: 'reply input'});
  await f.run('.aitc', {replyToId: 9});
  const body = JSON.parse(f.requests[0].init.body);
  assert.equal(body.messages[1].content, 'reply input');
  assert.equal(f.edits.at(-1).text, 'reply result');
});

test('aitc settings expose secret state through the Core redaction boundary', async t => {
  const f = await fixture(t);
  await f.host.patchSettings('aitc', {apiKey: 'sk-panel', model: 'panel-model'});
  const result = await f.host.readSettings('aitc');
  assert.equal(result.secretSet.apiKey, true);
  assert.equal(result.values.apiKey, undefined);
  assert.equal(result.values.model, 'panel-model');
});

test('aitc rejects invalid temperature and malformed provider output safely', async t => {
  const f = await fixture(t, {secret: 'provider-private'});
  await f.run('.aitc temp 3');
  assert.match(f.edits.at(-1).text, /0 到 2/);
  await f.run('.aitc key sk-test', {saved: true});
  await f.run('.aitc hello');
  assert.match(f.edits.at(-1).text, /调用失败/);
  assert.doesNotMatch(f.edits.map(item => item.text).join('\n'), /provider-private|sk-test/);
});
