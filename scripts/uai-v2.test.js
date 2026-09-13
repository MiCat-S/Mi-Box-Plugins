'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
function create(id) {const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, `../${id}`), entry: 'v2.ts'});
  delete require.cache[require.resolve(path.join(artifactDir, 'index.cjs'))]; return require(path.join(artifactDir, 'index.cjs')).default();}
function aiConfig(empty = false) {return {configs: empty ? {} : {main: {tag: 'main', url: 'https://ai.example.test/v1', key: 'central-key',
  model: 'unused', type: 'openai-compatible', stream: false, responses: false, models: {chat: 'central-model'}}},
  currentChatTag: empty ? '' : 'main', currentChatModel: empty ? '' : 'central-model', currentChatReasoningEffort: 'auto', currentChatServiceTier: 'auto',
  currentSearchTag: '', currentSearchModel: '', currentSearchReasoningEffort: 'auto', currentSearchServiceTier: 'auto', currentImageTag: '',
  currentImageModel: '', currentVideoTag: '', currentVideoModel: '', prompt: '', timeout: 30};}
async function fixture(t, {legacy, v2, clientPatch = {}, expectLoadFailure = false,
  fetchImpl = async () => Response.json({choices: [{message: {content: '结论 <安全>'}}]})} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-uai-')));
  await fs.mkdir(path.join(root, 'ai')); await fs.writeFile(path.join(root, 'ai', 'config.json'), JSON.stringify(aiConfig(Boolean(legacy))));
  if (legacy !== undefined || v2 !== undefined) await fs.mkdir(path.join(root, 'uai'));
  if (legacy !== undefined) await fs.writeFile(path.join(root, 'uai', 'config.json'), typeof legacy === 'string' ? legacy : JSON.stringify(legacy));
  if (v2 !== undefined) await fs.writeFile(path.join(root, 'uai', 'v2-config.json'), JSON.stringify(v2));
  const edits = [], replies = [], requests = [], logs = []; let reply;
  const client = {async getEntity() {return {firstName: '甲'};}, async *iterMessages() {
    yield {date: Math.floor(Date.now() / 1000), message: '第一条', senderId: 7n, sender: {firstName: '甲'}};
  }, ...clientPatch};
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error(event, fields) {logs.push({event, fields});}}, http: {fetch: async (url, init) => {
    requests.push({url: new URL(url), init}); return fetchImpl(url, init);
  }}, telegram: {async edit(_message, text, options) {edits.push({text, options});}, async reply(_message, text, options) {replies.push({text, options});}, async invoke() {},
    async getReply() {return reply;}, async withClient(operation, signal) {return operation(client, signal);}}});
  await host.load(create('ai')); let loadError;
  try { await host.load(create('uai')); } catch (error) { loadError = error; if (!expectLoadFailure) throw error; }
  t.after(async () => {if (host.pluginState('uai')) await host.shutdown(1000); else await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  return {root, host, edits, replies, requests, logs, loadError, setReply(value) {reply = value;}, run(text, message = {}) {
    return host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text, raw: {peerId: 'peer'}, ...message});
  }};
}

test('uai migrates every legacy provider into ai, remaps the default, and scrubs local keys', async t => {
  const legacy = {providers: {old: {name: 'old', base_url: 'https://legacy.example.test/base', api_key: 'legacy-secret', model: 'legacy-model', type: 'openai'},
    second: {name: 'second', base_url: 'https://generativelanguage.googleapis.com', api_key: 'gemini-secret', model: 'gemini-model', type: 'gemini'}},
    default_provider: 'old', collapse: false};
  const f = await fixture(t, {legacy});
  let ai = JSON.parse(await fs.readFile(path.join(f.root, 'ai', 'config.json'), 'utf8'));
  const local = JSON.parse(await fs.readFile(path.join(f.root, 'uai', 'v2-config.json'), 'utf8'));
  assert.deepEqual(Object.keys(ai.configs), ['uai-1', 'uai-2']);
  assert.equal(ai.currentChatTag, 'uai-1'); assert.equal(ai.currentChatModel, 'legacy-model');
  assert.equal(ai.configs['uai-1'].key, 'legacy-secret'); assert.equal(ai.configs['uai-2'].key, 'gemini-secret');
  assert.deepEqual(local.providers, {}); assert.equal(local.defaultProvider, null); assert.equal(local.collapse, false);
  assert.equal(JSON.stringify(local).includes('secret'), false);
  assert.equal((await f.host.unload('uai', 1000)).completed, true); await f.host.load(create('uai'));
  ai = JSON.parse(await fs.readFile(path.join(f.root, 'ai', 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(ai.configs), ['uai-1', 'uai-2']);
});

test('uai routes provider management to ai and exposes only prompts and display settings', async t => {
  const f = await fixture(t);
  for (const command of ['add p https://other.invalid key openai', 'set p', 'model p other', 'del p', 'list']) {
    await f.run(`.uai ${command}`, {saved: true}); assert.match(f.edits.at(-1).text, /ai 插件统一管理/);
  }
  const settings = await f.host.readSettings('uai');
  assert.deepEqual(Object.keys(settings.values).sort(), ['collapse', 'prompts']);
  assert.equal(settings.secretSet.providers, undefined);
});

test('uai analyzes referenced history through the current central chat provider', async t => {
  const f = await fixture(t);
  f.setReply({id: 2, chatId: '1', senderId: '7', outgoing: false, text: '第一条', raw: {senderId: 7n, sender: {firstName: '甲'}}});
  await f.run('.uai zj 1', {replyToId: 2});
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url.href, 'https://ai.example.test/v1/chat/completions');
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer central-key');
  const body = JSON.parse(f.requests[0].init.body);
  assert.equal(body.model, 'central-model'); assert.match(body.messages.at(-1).content, /第一条/);
  assert.match(f.edits.at(-1).text, /&lt;安全&gt;/); assert.doesNotMatch(f.edits.map(item => item.text).join('\n'), /central-key/);
});

test('uai cancels an in-flight central AI request on unload', async t => {
  let began; const started = new Promise(resolve => {began = resolve;});
  const f = await fixture(t, {fetchImpl: async (_url, init) => {began(); return new Promise((_resolve, reject) =>
    init.signal.addEventListener('abort', () => reject(new Error('private provider detail')), {once: true}));}});
  f.setReply({id: 2, text: 'x', raw: {senderId: 7n, sender: {firstName: '甲'}}});
  const running = f.run('.uai zj 1', {replyToId: 2}); await started;
  assert.equal((await f.host.unload('uai', 1000)).completed, true); await running;
  assert.equal(f.host.pluginState('uai'), undefined);
  assert.doesNotMatch(f.edits.map(item => item.text).join('\n'), /private provider detail/);
});

test('corrupt legacy state fails setup without marking migration and succeeds on retry', async t => {
  const f = await fixture(t, {legacy: '{broken', expectLoadFailure: true});
  assert.ok(f.loadError instanceof Error);
  await assert.rejects(fs.readFile(path.join(f.root, 'uai', 'v2-config.json'), 'utf8'), error => error.code === 'ENOENT');
  await fs.writeFile(path.join(f.root, 'uai', 'config.json'), JSON.stringify({prompts: {fixed: '已修复'}, collapse: false}));
  await f.host.load(create('uai'));
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'uai', 'v2-config.json'), 'utf8'));
  assert.equal(state.legacyImported, true);
  assert.equal(state.prompts.fixed, '已修复');
  assert.equal(state.collapse, false);
});

test('legacy defaults do not overwrite explicit V2 prompts or collapse choice', async t => {
  const f = await fixture(t, {legacy: {providers: {}, prompts: {same: '旧值', legacy: '保留'}, collapse: false},
    v2: {schemaVersion: 2, providers: {}, defaultProvider: null, prompts: {same: '新值'}, collapse: true, legacyImported: false, aiMigrated: false}});
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'uai', 'v2-config.json'), 'utf8'));
  assert.equal(state.prompts.same, '新值');
  assert.equal(state.prompts.legacy, '保留');
  assert.equal(state.collapse, true);
});

test('a stale completed marker cannot skip newly recovered legacy providers', async t => {
  const legacy = {providers: {recovered: {name: 'recovered', base_url: 'https://recovered.example.test', api_key: 'recovered-secret', model: 'recovered-model', type: 'openai'}}, default_provider: 'recovered'};
  const v2 = {schemaVersion: 2, providers: {}, defaultProvider: null, prompts: {}, collapse: true, legacyImported: false, aiMigrated: true};
  const f = await fixture(t, {legacy, v2});
  const ai = JSON.parse(await fs.readFile(path.join(f.root, 'ai', 'config.json'), 'utf8'));
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'uai', 'v2-config.json'), 'utf8'));
  assert.equal(ai.configs['uai-1'].key, 'recovered-secret');
  assert.equal(ai.currentChatTag, 'uai-1');
  assert.equal(state.legacyImported, true);
  assert.equal(state.aiMigrated, true);
  assert.deepEqual(state.providers, {});
});

test('legacy import atomically preserves prompt and collapse writes made while reading', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-uai-race-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({prompts: {legacy: '旧提示'}, collapse: true}));
  let state = {schemaVersion: 2, providers: {}, defaultProvider: null, prompts: {}, collapse: true, legacyImported: false, aiMigrated: true};
  let entered, release;
  const ready = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const signal = new AbortController().signal;
  const context = {
    signal,
    tasks: {async run(label, operation) {if (label === 'uai:legacy-read') {entered(); await gate;} return operation(signal);}},
    files: {dataPath(file) {return path.join(root, file);}},
    storage: {json() {return {async read() {return structuredClone(state);}, async update(mutator) {state = await mutator(structuredClone(state)); return structuredClone(state);}};}},
    services: {available() {return false;}},
  };
  const settings = create('uai').settings(context);
  const reading = settings.getValues();
  await ready;
  await settings.setValues({prompts: {fresh: '新提示'}, collapse: false});
  release();
  await reading;
  assert.deepEqual(state.prompts, {legacy: '旧提示', fresh: '新提示'});
  assert.equal(state.collapse, false);
  assert.equal(state.legacyImported, true);
});

test('legacy-key scrub failure leaves AI migration retryable', async t => {
  const originalRename = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (source, destination) => {
    if (String(destination).endsWith('/uai/config.json')) throw Object.assign(new Error('scrub denied'), {code: 'EACCES'});
    return originalRename(source, destination);
  });
  const legacy = {providers: {old: {name: 'old', base_url: 'https://legacy.example.test', api_key: 'retry-secret', model: 'legacy-model', type: 'openai'}}, default_provider: 'old'};
  const f = await fixture(t, {legacy, expectLoadFailure: true});
  assert.ok(f.loadError instanceof Error);
  let state = JSON.parse(await fs.readFile(path.join(f.root, 'uai', 'v2-config.json'), 'utf8'));
  assert.equal(state.aiMigrated, false);
  mocked.mock.restore();
  await f.host.load(create('uai'));
  state = JSON.parse(await fs.readFile(path.join(f.root, 'uai', 'v2-config.json'), 'utf8'));
  const scrubbed = JSON.parse(await fs.readFile(path.join(f.root, 'uai', 'config.json'), 'utf8'));
  assert.equal(state.aiMigrated, true);
  assert.deepEqual(state.providers, {});
  assert.deepEqual(scrubbed.providers, {});
  assert.doesNotMatch(JSON.stringify({state, scrubbed}), /retry-secret/);
});

test('long AI output is escaped and delivered completely across labelled SDK pages', async t => {
  const answer = `${'<段落>&'.repeat(900)}终点`;
  const f = await fixture(t, {fetchImpl: async () => Response.json({choices: [{message: {content: answer}}]})});
  f.setReply({id: 2, text: 'x', raw: {senderId: 7n, sender: {firstName: '甲'}}});
  await f.run('.uai zj 1', {replyToId: 2});
  const delivered = [f.edits.at(-1).text, ...f.replies.map(item => item.text)].join('');
  assert.ok(f.replies.length > 0);
  assert.match(delivered, /终点/);
  assert.doesNotMatch(delivered, /输出已截断/);
  assert.doesNotMatch(delivered, /<段落>/);
  assert.ok([f.edits.at(-1), ...f.replies].every(item => item.text.length <= 3500));
});

test('cancellation while getEntity settles never starts history iteration', async t => {
  let entered, release, iterations = 0;
  const ready = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, {clientPatch: {
    async getEntity() {entered(); await gate; throw new Error('entity unavailable');},
    async *iterMessages() {iterations++; yield {message: 'late'};},
  }});
  f.setReply({id: 2, text: 'x', raw: {senderId: 7n, sender: {firstName: '甲'}}});
  const running = f.run('.uai zj 1', {replyToId: 2});
  await ready;
  const unloading = f.host.unload('uai', 1000);
  release();
  assert.equal((await unloading).completed, true);
  await running;
  assert.equal(iterations, 0);
});
