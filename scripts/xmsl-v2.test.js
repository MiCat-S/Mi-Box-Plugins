'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'xmsl', packageRoot: path.resolve(__dirname, '../xmsl'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

async function hosted(t, legacy) {
  const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-xmsl-host-')));
  if (legacy) {
    await fs.mkdir(path.join(root, 'xmsl'));
    await fs.writeFile(path.join(root, 'xmsl', 'config.json'), JSON.stringify(legacy));
  }
  const edits = [], requests = [];
  const host = new PluginHost({storageRoot: root, processes: {timeoutMs: 90000, maxOutputBytes: 256 * 1024},
    logger: {info() {}, error() {}},
    http: {fetch: async (url, init) => {
      requests.push({url: new URL(url), init});
      const body = JSON.parse(init.body);
      return Response.json(body.contents ? {candidates: [{content: {parts: [{text: '羡慕会玩'}]}}]} : {choices: [{message: {content: '<think>隐藏</think> 羡慕富哥'}}]});
    }},
    telegram: {async edit(message, text, options) {edits.push({message, text, options});}, async reply() {}, async invoke() {}, async getReply() {},
      async withClient() {assert.fail('unexpected native Telegram call');}},
  });
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  const run = (text, message = {}) => host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text, ...message});
  return {host, edits, requests, run};
}

test('xmsl loads in PluginHost, persists config across unload and calls OpenAI safely', async t => {
  const f = await hosted(t);
  assert.deepEqual(f.host.listCommands().filter(x => x.pluginId === 'xmsl').map(x => x.name), ['xm', 'xmsl']);
  await f.run('.xm set key sk-leak');
  assert.match(f.edits.at(-1).text, /仅允许在收藏夹/);
  await f.run('.xm set key sk-test', {saved: true});
  await f.run('.xm set url https://api.example.test/v1');
  await f.run('.xm set model vision-model');
  await f.run('.xmsl 买新手机了');
  assert.equal(f.requests[0].url.href, 'https://api.example.test/v1/chat/completions');
  assert.equal(f.requests[0].init.redirect, 'manual');
  assert.equal(f.requests[0].init.headers.authorization, 'Bearer sk-test');
  assert.equal(JSON.parse(f.requests[0].init.body).model, 'vision-model');
  assert.equal(f.edits.at(-1).text, '羡慕富哥');
  assert.doesNotMatch(f.edits.map(x => x.text).join('\n'), /sk-test|sk-leak/);
  assert.equal((await f.host.unload('xmsl', 1000)).completed, true);
  await f.host.load(create());
  await f.run('.xm show');
  assert.match(f.edits.at(-1).text, /vision-model/);
});

test('xmsl supports Gemini and reply text while settings redact the key', async t => {
  const f = await hosted(t);
  await f.host.patchSettings('xmsl', {apiMode: 'gemini', apiKey: 'gemini-secret', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-test'});
  const settings = await f.host.readSettings('xmsl');
  assert.equal(settings.secretSet.apiKey, true);
  assert.equal(settings.values.apiKey, undefined);
  f.host.options.telegram.getReply = async () => ({id: 2, chatId: '1', senderId: '2', outgoing: false, text: '今天吃寿司'});
  await f.run('.xm', {replyToId: 2});
  assert.equal(f.requests[0].url.href, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.equal(f.requests[0].init.headers['x-goog-api-key'], 'gemini-secret');
  assert.equal(f.requests[0].url.search, '');
  assert.equal(f.edits.at(-1).text, '羡慕会玩');
});

test('xmsl imports the legacy config shape idempotently', async t => {
  const f = await hosted(t, {apiMode: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/', apiKey: 'legacy-secret', model: 'legacy-model', future: 'preserved'});
  await f.run('.xm show');
  assert.match(f.edits.at(-1).text, /gemini[\s\S]*legacy-model/);
  const stored = JSON.parse(await fs.readFile(path.join(f.host.options.storageRoot, 'xmsl', 'config.json'), 'utf8'));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.importedLegacy, true);
  assert.equal(stored.future, 'preserved');
  assert.equal(stored.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
});

function direct(options = {}) {
  const edits = [], calls = [], requests = [];
  let state = {schemaVersion: 1, apiMode: options.mode || 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'secret', model: 'vision', importedLegacy: true};
  const signal = new AbortController().signal;
  const context = {signal, log: {info() {}, error() {}},
    storage: {json() {return {async read() {return structuredClone(state);}, async update(change) {state = await change(structuredClone(state)); return structuredClone(state);}};}},
    files: {async withTemp(use) {const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-xmsl-media-')); try {return await use(dir, signal);} finally {await fs.rm(dir, {recursive: true, force: true});}}},
    processes: {async run(command, args, runOptions) {calls.push({command, args, options: runOptions}); if (options.processError) throw options.processError;
      const output = args.at(-1); if (output.endsWith('.gif')) await fs.writeFile(output, 'gif'); else await fs.writeFile(output, Buffer.from([0x89,0x50,0x4e,0x47,1])); return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0};}},
    http: {async withResponse(url, init, consume, requestOptions) {requests.push({url: new URL(url), init, requestOptions}); return consume(Response.json(options.response || {choices: [{message: {content: '羡慕猫奴'}}]}), signal);}},
    telegram: {async edit(message, text, editOptions) {edits.push({message, text, options: editOptions});}, async getReply() {return options.reply;},
      async withClient(operation) {return operation({async *iterDownload() {yield options.mediaBytes || Buffer.from([0x89,0x50,0x4e,0x47,1]);}}, signal);}},
  };
  const run = (text = '.xmsl') => create().commands.xmsl.handle({command: 'xmsl', prefix: '.', args: text.split(/\s+/).slice(1), message: {id: 1, chatId: '1', senderId: '1', outgoing: true, text, replyToId: 2, raw: {peerId: 1}}}, context);
  return {edits, calls, requests, run};
}

test('xmsl sends replied static images as bounded OpenAI vision input', async () => {
  const reply = {id: 2, text: '猫', raw: {media: {photo: {}}, photo: {}}};
  const f = direct({reply});
  await f.run();
  const body = JSON.parse(f.requests[0].init.body);
  assert.equal(body.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,'), true);
  assert.deepEqual(f.requests[0].requestOptions.redirects, {allowedHosts: ['api.example.test'], maxRedirects: 2});
  assert.equal(f.edits.at(-1).text, '羡慕猫奴');
});

test('xmsl extracts WebM and TGS first frames with fixed helpers', async () => {
  const webm = direct({reply: {id: 2, text: '', raw: {media: {document: {mimeType: 'video/webm', attributes: [{className: 'DocumentAttributeSticker'}]}}}}, mediaBytes: Buffer.from('webm')});
  await webm.run();
  assert.equal(webm.calls[0].command, '/usr/bin/ffmpeg');
  assert.deepEqual(webm.calls[0].args.slice(0, 3), ['-nostdin', '-y', '-i']);
  const tgs = direct({reply: {id: 2, text: '', raw: {media: {document: {mimeType: 'application/x-tgsticker', attributes: [{className: 'DocumentAttributeSticker'}]}}}}, mediaBytes: Buffer.from('tgs')});
  await tgs.run();
  assert.equal(tgs.calls[0].command, '/usr/bin/python3');
  assert.equal(tgs.calls[1].command, '/usr/bin/ffmpeg');
  assert.equal(tgs.requests.length, 1);
});

test('xmsl never retries another helper after timeout and declares its budget', async () => {
  const error = Object.assign(new Error('private argv'), {code: 'TIMED_OUT'});
  const f = direct({reply: {id: 2, text: '', raw: {media: {document: {mimeType: 'video/webm', attributes: [{className: 'DocumentAttributeSticker'}]}}}}, mediaBytes: Buffer.from('webm'), processError: error});
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.match(f.edits.at(-1).text, /调用失败/);
  assert.doesNotMatch(f.edits.at(-1).text, /private argv/);
  assert.deepEqual(create().resources.processes, {concurrency: 1, queueCapacity: 1, timeoutMs: 90000, maxOutputBytes: 256 * 1024});
});
