'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const Database = require(require.resolve('better-sqlite3', {paths: [core]}));

function plugin(id) {
  const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, `../${id}`), entry: 'v2.ts'});
  delete require.cache[require.resolve(path.join(artifactDir, 'index.cjs'))];
  return require(path.join(artifactDir, 'index.cjs')).default();
}

function centralConfig() {
  return {
    configs: {
      main: {tag: 'main', url: 'https://central.example.test/v1', key: 'central-secret',
        type: 'openai-compatible', stream: false, responses: false, models: {chat: 'central-model'}},
      'sum-legacy': {tag: 'sum-legacy', url: 'https://occupied.example.test/v1', key: 'occupied-secret',
        type: 'openai-compatible', stream: false, responses: false, models: {chat: 'occupied-model'}},
    },
    currentChatTag: 'main', currentChatModel: 'central-model',
    currentChatReasoningEffort: 'auto', currentChatServiceTier: 'auto',
    currentSearchTag: '', currentSearchModel: '', currentSearchReasoningEffort: 'auto', currentSearchServiceTier: 'auto',
    currentImageTag: '', currentImageModel: '', currentVideoTag: '', currentVideoModel: '',
    prompt: '', timeout: 30, collapse: true,
  };
}

async function temporaryRoot(t, prefix) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(async () => fs.rm(root, {recursive: true, force: true}));
  return root;
}

test('sum migrates legacy providers into ai, remaps task tags, and calls the unified chat service', async t => {
  const root = await temporaryRoot(t, 'mibot-sum-unified-');
  await fs.mkdir(path.join(root, 'ai'), {recursive: true});
  await fs.writeFile(path.join(root, 'ai', 'config.json'), JSON.stringify(centralConfig()));
  await fs.mkdir(path.join(root, 'sum'), {recursive: true});
  await fs.writeFile(path.join(root, 'sum', 'database.json'), JSON.stringify({
    seq: '1',
    tasks: [{id: '1', cron: '0 */2 * * *', chatId: '-10010', interval: '2h', messageCount: 10,
      pushTarget: 'me', aiProvider: 'legacy', createdAt: '2026-01-01T00:00:00.000Z'}],
    aiConfig: {
      providers: {legacy: {name: 'Legacy', base_url: 'https://legacy.example.test', api_key: 'legacy-secret', model: 'legacy-model', type: 'chat'}},
      default_provider: 'legacy', default_prompt: 'summary prompt', default_spoiler: false,
      default_timeout: 60000, default_reasoning_effort: 'high', default_service_tier: 'priority',
      reply_mode: true, max_output_length: 0, link_preview: false, aiMigrated: false,
    },
  }));

  const requests = [], sent = [], edits = [];
  const client = {
    async getEntity() {return {title: '测试群', username: 'testgroup'};},
    async *iterMessages() {
      yield {id: 9, message: '第二条消息', sender: {firstName: '乙'}, senderId: 2};
      yield {id: 8, message: '第一条消息', sender: {firstName: '甲'}, senderId: 1};
    },
    async sendMessage(peer, value) {sent.push({peer, value});},
  };
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}},
    http: {fetch: async (url, init) => {
      requests.push({url: new URL(url), init});
      return Response.json({choices: [{message: {content: '<b>统一摘要</b>'}}]});
    }},
    telegram: {async edit(_message, text, options) {edits.push({text, options});}, async reply() {}, async invoke() {},
      async getReply() {}, async withClient(operation, signal) {return operation(client, signal);}},
  });
  t.after(async () => assert.equal((await host.shutdown(2000)).completed, true));
  await host.load(plugin('ai'));
  await host.load(plugin('sum'));

  const local = JSON.parse(await fs.readFile(path.join(root, 'sum', 'database.json'), 'utf8'));
  assert.deepEqual(local.aiConfig.providers, {});
  assert.equal(local.tasks[0].aiProvider, 'sum-legacy-2');
  for (const field of ['default_provider', 'default_timeout', 'default_reasoning_effort', 'default_service_tier', 'reply_mode']) {
    assert.equal(Object.hasOwn(local.aiConfig, field), false);
  }
  const central = JSON.parse(await fs.readFile(path.join(root, 'ai', 'config.json'), 'utf8'));
  assert.equal(central.configs['sum-legacy'].key, 'occupied-secret');
  assert.equal(central.configs['sum-legacy-2'].key, 'legacy-secret');
  assert.equal(central.configs['sum-legacy-2'].models.chat, 'legacy-model');

  await host.dispatchPrimary({id: 20, chatId: '-10010', senderId: '1', outgoing: true, text: '.sum run 1', raw: {peerId: {}}});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.href, 'https://legacy.example.test/v1/chat/completions');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer legacy-secret');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'legacy-model');
  assert.equal(body.max_tokens, 2000);
  assert.equal(body.messages[0].content, 'summary prompt');
  assert.match(body.messages[1].content, /第一条消息/);
  assert.equal(sent[0].peer, 'me');
  assert.match(sent[0].value.message, /统一摘要/);
  assert.doesNotMatch(edits.map(item => item.text).join('\n'), /legacy-secret|occupied-secret|central-secret/);
});

test('sum loads when legacy default providers have empty keys and scrubs unusable entries', async t => {
  const root = await temporaryRoot(t, 'mibot-sum-empty-legacy-');
  await fs.mkdir(path.join(root, 'ai'), {recursive: true});
  await fs.writeFile(path.join(root, 'ai', 'config.json'), JSON.stringify(centralConfig()));
  await fs.mkdir(path.join(root, 'sum'), {recursive: true});
  await fs.writeFile(path.join(root, 'sum', 'database.json'), JSON.stringify({
    seq: '0', tasks: [], aiConfig: {
      providers: {
        openai: {name: 'OpenAI', base_url: 'https://api.openai.com', api_key: '', model: 'gpt-4o', type: 'openai'},
        gemini: {name: 'Gemini', base_url: 'https://generativelanguage.googleapis.com', api_key: '', model: 'gemini-2.0-flash', type: 'gemini'},
      },
      default_provider: 'openai', default_prompt: 'summary prompt', aiMigrated: false,
    },
  }));
  const events = [];
  const unavailable = async () => {throw new Error('offline');};
  const host = new PluginHost({storageRoot: root, logger: {info(event, fields) {events.push({event, fields});}, error() {}},
    telegram: {edit: unavailable, reply: unavailable, invoke: unavailable, getReply: unavailable, withClient: unavailable}});
  t.after(async () => assert.equal((await host.shutdown(2000)).completed, true));
  await host.load(plugin('ai'));
  await host.load(plugin('sum'));
  assert.equal(host.pluginState('sum'), 'active');
  const local = JSON.parse(await fs.readFile(path.join(root, 'sum', 'database.json'), 'utf8'));
  assert.equal(local.aiConfig.aiMigrated, true);
  assert.deepEqual(local.aiConfig.providers, {});
  assert.equal(Object.hasOwn(local.aiConfig, 'default_provider'), false);
  assert.deepEqual(events.filter(item => item.event === 'sum:legacy-provider-skipped'),
    [{event: 'sum:legacy-provider-skipped', fields: {count: 2}}]);
});

test('convert imports and scrubs its legacy SQLite key exactly once', async t => {
  const root = await temporaryRoot(t, 'mibot-convert-unified-');
  const directory = path.join(root, 'convert');
  await fs.mkdir(directory, {recursive: true});
  const legacyFile = path.join(directory, 'gemini_config.db');
  const database = new Database(legacyFile);
  database.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  database.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('convert_gemini_api_key', 'sqlite-secret');
  database.close();

  const unavailable = async () => {throw new Error('offline');};
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}},
    processes: {concurrency: 1, queueCapacity: 2, timeoutMs: 180000, maxOutputBytes: 256 * 1024},
    telegram: {edit: unavailable, reply: unavailable, invoke: unavailable, getReply: unavailable, withClient: unavailable}});
  t.after(async () => assert.equal((await host.shutdown(2000)).completed, true));
  await host.load(plugin('ai'));
  await host.load(plugin('convert'));

  let central = JSON.parse(await fs.readFile(path.join(root, 'ai', 'config.json'), 'utf8'));
  let local = JSON.parse(await fs.readFile(path.join(root, 'convert', 'config.json'), 'utf8'));
  assert.equal(central.configs.convert.key, 'sqlite-secret');
  assert.equal(central.configs.convert.models.search, 'gemini-1.5-flash-latest');
  assert.equal(central.currentSearchTag, 'convert');
  assert.equal(local.apiKey, '');
  const inspect = new Database(legacyFile, {readonly: true});
  assert.equal(inspect.prepare('SELECT value FROM config WHERE key = ?').get('convert_gemini_api_key').value, '');
  inspect.close();

  assert.equal((await host.unload('convert', 2000)).completed, true);
  await host.load(plugin('convert'));
  central = JSON.parse(await fs.readFile(path.join(root, 'ai', 'config.json'), 'utf8'));
  local = JSON.parse(await fs.readFile(path.join(root, 'convert', 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(central.configs), ['convert']);
  assert.equal(local.aiMigrated, true);
});
