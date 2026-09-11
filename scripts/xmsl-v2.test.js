'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
function create(id) {const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, `../${id}`), entry: 'v2.ts'});
  delete require.cache[require.resolve(path.join(artifactDir, 'index.cjs'))]; return require(path.join(artifactDir, 'index.cjs')).default();}
const central = {configs: {main: {tag: 'main', url: 'https://api.example.test/v1', key: 'central-key', type: 'openai-compatible',
  stream: false, responses: false, models: {chat: 'vision-model'}}}, currentChatTag: 'main', currentChatModel: 'vision-model',
  currentChatReasoningEffort: 'auto', currentChatServiceTier: 'auto', currentSearchTag: '', currentSearchModel: '',
  currentSearchReasoningEffort: 'auto', currentSearchServiceTier: 'auto', currentImageTag: '', currentImageModel: '',
  currentVideoTag: '', currentVideoModel: '', prompt: '', timeout: 30};

async function hosted(t, legacy) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-xmsl-host-')));
  await fs.mkdir(path.join(root, 'ai')); await fs.writeFile(path.join(root, 'ai', 'config.json'), JSON.stringify(legacy ? {...central, configs: {}, currentChatTag: '', currentChatModel: ''} : central));
  if (legacy) {await fs.mkdir(path.join(root, 'xmsl')); await fs.writeFile(path.join(root, 'xmsl', 'config.json'), JSON.stringify(legacy));}
  const edits = [], requests = []; let reply;
  const host = new PluginHost({storageRoot: root, processes: {timeoutMs: 90000, maxOutputBytes: 256 * 1024}, logger: {info() {}, error() {}},
    http: {fetch: async (url, init) => {requests.push({url: new URL(url), init}); return Response.json({choices: [{message: {content: '<think>隐藏</think> 羡慕富哥'}}]});}},
    telegram: {async edit(_message, text, options) {edits.push({text, options});}, async reply() {}, async invoke() {}, async getReply() {return reply;},
      async withClient() {assert.fail('unexpected native Telegram call');}}});
  await host.load(create('ai')); await host.load(create('xmsl'));
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  return {root, host, edits, requests, setReply(value) {reply = value;},
    run: (text, message = {}) => host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text, ...message})};
}

test('xmsl uses the current central chat provider and redirects old provider commands', async t => {
  const f = await hosted(t);
  assert.deepEqual(f.host.listCommands().filter(item => item.pluginId === 'xmsl').map(item => item.name), ['xm', 'xmsl']);
  await f.run('.xm set key local-secret', {saved: true});
  assert.match(f.edits.at(-1).text, /ai 插件统一管理/);
  await f.run('.xmsl 买新手机了');
  assert.equal(f.requests[0].url.href, 'https://api.example.test/v1/chat/completions');
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer central-key');
  assert.equal(JSON.parse(f.requests[0].init.body).model, 'vision-model');
  assert.equal(f.edits.at(-1).text, '羡慕富哥');
  await assert.rejects(f.host.readSettings('xmsl'), /unavailable/i);
});

test('xmsl migrates its legacy provider to ai and scrubs local credentials idempotently', async t => {
  const f = await hosted(t, {apiMode: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/',
    apiKey: 'legacy-secret', model: 'legacy-model', importedLegacy: true, future: 'preserved'});
  let ai = JSON.parse(await fs.readFile(path.join(f.root, 'ai', 'config.json'), 'utf8'));
  let local = JSON.parse(await fs.readFile(path.join(f.root, 'xmsl', 'config.json'), 'utf8'));
  assert.equal(ai.configs.xmsl.key, 'legacy-secret');
  assert.equal(ai.configs.xmsl.models.chat, 'legacy-model');
  assert.equal(ai.currentChatTag, 'xmsl');
  assert.equal(local.apiKey, ''); assert.equal(local.baseUrl, ''); assert.equal(local.model, '');
  assert.equal(local.future, 'preserved');
  assert.equal((await f.host.unload('xmsl', 1000)).completed, true); await f.host.load(create('xmsl'));
  ai = JSON.parse(await fs.readFile(path.join(f.root, 'ai', 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(ai.configs), ['xmsl']);
});

function direct(options = {}) {
  const edits = [], calls = [], serviceCalls = []; const signal = new AbortController().signal;
  let state = {schemaVersion: 1, apiMode: 'openai', baseUrl: '', apiKey: '', model: '', importedLegacy: true, aiMigrated: true};
  const context = {signal, log: {info() {}, error() {}}, storage: {json() {return {async read() {return structuredClone(state);},
    async update(change) {state = await change(structuredClone(state)); return structuredClone(state);}};}},
    services: {available(id, service) {return id === 'ai' && ['chat', 'selection'].includes(service);}, async call(id, service, input) {
      serviceCalls.push({id, service, input}); if (service === 'selection') return {chat: {tag: 'main', model: 'vision'}}; return '羡慕猫奴';
    }},
    files: {async withTemp(use) {const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-xmsl-media-')); try {return await use(dir, signal);} finally {await fs.rm(dir, {recursive: true, force: true});}}},
    processes: {async run(command, args, runOptions) {calls.push({command, args, options: runOptions}); if (options.processError) throw options.processError;
      const output = args.at(-1); if (output.endsWith('.gif')) await fs.writeFile(output, 'gif'); else await fs.writeFile(output, Buffer.from([0x89,0x50,0x4e,0x47,1])); return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0};}},
    telegram: {async edit(_message, text, editOptions) {edits.push({text, options: editOptions});}, async getReply() {return options.reply;},
      async withClient(operation) {return operation({async *iterDownload() {yield options.mediaBytes || Buffer.from([0x89,0x50,0x4e,0x47,1]);}}, signal);}}};
  const run = (text = '.xmsl') => create('xmsl').commands.xmsl.handle({command: 'xmsl', prefix: '.', args: text.split(/\s+/).slice(1),
    message: {id: 1, chatId: '1', senderId: '1', outgoing: true, text, replyToId: 2, raw: {peerId: 1}}}, context);
  return {edits, calls, serviceCalls, run};
}

test('xmsl sends replied static images to the central multimodal chat service', async () => {
  const f = direct({reply: {id: 2, text: '猫', raw: {media: {photo: {}}, photo: {}}}}); await f.run();
  const input = f.serviceCalls.find(call => call.service === 'chat').input;
  assert.equal(input.images[0].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(input.images[0].data), Buffer.from([0x89,0x50,0x4e,0x47,1]));
  assert.equal(f.edits.at(-1).text, '羡慕猫奴');
});

test('xmsl extracts WebM and TGS first frames with bounded helpers', async () => {
  const webm = direct({reply: {id: 2, text: '', raw: {media: {document: {mimeType: 'video/webm', attributes: [{className: 'DocumentAttributeSticker'}]}}}}, mediaBytes: Buffer.from('webm')});
  await webm.run(); assert.equal(webm.calls[0].command, '/usr/bin/ffmpeg'); assert.deepEqual(webm.calls[0].args.slice(0, 3), ['-nostdin', '-y', '-i']);
  const tgs = direct({reply: {id: 2, text: '', raw: {media: {document: {mimeType: 'application/x-tgsticker', attributes: [{className: 'DocumentAttributeSticker'}]}}}}, mediaBytes: Buffer.from('tgs')});
  await tgs.run(); assert.equal(tgs.calls[0].command, '/usr/bin/python3'); assert.equal(tgs.calls[1].command, '/usr/bin/ffmpeg');
  assert.equal(tgs.serviceCalls.filter(call => call.service === 'chat').length, 1);
});

test('xmsl stops after a timed-out media helper and declares its process budget', async () => {
  const f = direct({reply: {id: 2, text: '', raw: {media: {document: {mimeType: 'video/webm', attributes: [{className: 'DocumentAttributeSticker'}]}}}},
    mediaBytes: Buffer.from('webm'), processError: Object.assign(new Error('private argv'), {code: 'TIMED_OUT'})});
  await f.run(); assert.equal(f.calls.length, 1); assert.match(f.edits.at(-1).text, /调用失败/); assert.doesNotMatch(f.edits.at(-1).text, /private argv/);
  assert.deepEqual(create('xmsl').resources.processes, {concurrency: 1, queueCapacity: 1, timeoutMs: 90000, maxOutputBytes: 256 * 1024});
});
