'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

function create(id) {
  const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, `../${id}`), entry: 'v2.ts'});
  delete require.cache[require.resolve(path.join(artifactDir, 'index.cjs'))];
  return require(path.join(artifactDir, 'index.cjs')).default();
}
function aiConfig() {
  return {configs: {main: {tag: 'main', url: 'https://api.example.test/v1', key: 'central-secret',
    type: 'openai-compatible', stream: false, responses: false, models: {chat: 'central-model'}}},
    currentChatTag: 'main', currentChatModel: 'central-model', currentChatReasoningEffort: 'auto', currentChatServiceTier: 'auto',
    currentSearchTag: '', currentSearchModel: '', currentSearchReasoningEffort: 'auto', currentSearchServiceTier: 'auto',
    currentImageTag: '', currentImageModel: '', currentVideoTag: '', currentVideoModel: '', timeout: 30, prompt: '', collapse: true,
    imagePreview: true, videoPreview: true, videoAudio: false, videoDuration: 5, telegraphToken: '', telegraph: {enabled: false, limit: 5, list: []}};
}
async function fixture(t, {ai = aiConfig(), legacy, response = {choices: [{message: {content: 'translated'}}]}} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-aitc-v2-')));
  if (ai) {await fs.mkdir(path.join(root, 'ai')); await fs.writeFile(path.join(root, 'ai', 'config.json'), JSON.stringify(ai));}
  if (legacy) {await fs.mkdir(path.join(root, 'aitc')); await fs.writeFile(path.join(root, 'aitc', 'config.json'), JSON.stringify(legacy));}
  const edits = [], requests = []; let reply;
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch: async (url, init) => {
    requests.push({url: new URL(url), init}); return Response.json(response);
  }}, telegram: {async edit(_message, text, options) {edits.push({text, options});}, async reply() {}, async invoke() {},
    async getReply() {return reply;}, async withClient() {assert.fail('unexpected native call');}}});
  await host.load(create('ai')); await host.load(create('aitc'));
  t.after(async () => {assert.equal((await host.shutdown(1000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  return {root, host, edits, requests, setReply(value) {reply = value;},
    run: (text, message = {}) => host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text, ...message})};
}

test('aitc routes provider commands to ai and exposes only prompt behavior in settings', async t => {
  const f = await fixture(t);
  for (const command of ['key secret', 'url https://other.invalid', 'model other']) {
    await f.run(`.aitc ${command}`, {saved: true});
    assert.match(f.edits.at(-1).text, /ai 插件统一管理/);
  }
  const settings = await f.host.readSettings('aitc');
  assert.deepEqual(Object.keys(settings.values).sort(), ['prompt', 'prompts', 'temperature']);
  assert.equal(settings.secretSet.apiKey, undefined);
  assert.doesNotMatch(JSON.stringify(settings), /central-secret/);
});

test('aitc uses the central provider with its own prompt, preset and temperature', async t => {
  const f = await fixture(t);
  await f.run('.aitc temp 0.7');
  await f.run('.aitc spn casual Use a casual voice');
  await f.run('.aitc casual 你好');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url.href, 'https://api.example.test/v1/chat/completions');
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer central-secret');
  const body = JSON.parse(f.requests[0].init.body);
  assert.equal(body.model, 'central-model');
  assert.equal(body.temperature, 0.7);
  assert.equal(body.messages[0].content, 'Use a casual voice');
  assert.equal(body.messages[1].content, '你好');
  assert.equal(f.edits.at(-1).text, 'translated');
});

test('aitc uses replied text and migrates a legacy provider into ai exactly once', async t => {
  const legacy = {apiKey: 'legacy-secret', apiUrl: 'https://legacy.example.test', model: 'legacy-model',
    prompt: 'legacy prompt', prompts: {}, temperature: 0.2, aiMigrated: false};
  const f = await fixture(t, {ai: null, legacy});
  let central = JSON.parse(await fs.readFile(path.join(f.root, 'ai', 'config.json'), 'utf8'));
  const local = JSON.parse(await fs.readFile(path.join(f.root, 'aitc', 'config.json'), 'utf8'));
  assert.equal(central.configs.aitc.key, 'legacy-secret');
  assert.equal(central.configs.aitc.models.chat, 'legacy-model');
  assert.equal(central.currentChatTag, 'aitc');
  assert.equal(local.apiKey, ''); assert.equal(local.apiUrl, ''); assert.equal(local.model, '');
  f.setReply({text: 'reply input'});
  await f.run('.aitc', {replyToId: 9});
  assert.equal(JSON.parse(f.requests[0].init.body).messages.at(-1).content, 'reply input');
  assert.equal((await f.host.unload('aitc', 1000)).completed, true);
  await f.host.load(create('aitc'));
  central = JSON.parse(await fs.readFile(path.join(f.root, 'ai', 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(central.configs), ['aitc']);
});

test('aitc keeps provider failures and credentials out of user-visible output', async t => {
  const f = await fixture(t, {response: {secret: 'provider-private'}});
  await f.run('.aitc hello');
  assert.match(f.edits.at(-1).text, /调用失败/);
  assert.doesNotMatch(f.edits.map(item => item.text).join('\n'), /provider-private|central-secret/);
});
