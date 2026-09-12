'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const esbuild = require(path.join(core, 'node_modules/esbuild'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'say', packageRoot: path.resolve(__dirname, '../say'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t, responder) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-say-v2-')));
  const edits = [], requests = [], sent = [], deleted = [];
  const audio = Buffer.from('OggS scoped voice');
  const host = new PluginHost({storageRoot: root,
    processes: {concurrency: 1, queueCapacity: 3, timeoutMs: 180_000, maxOutputBytes: 256 * 1024},
    logger: {info() {}, error() {}}, http: {async fetch(url, init) {
    requests.push({url: new URL(url), init});
    if (responder) return responder(new URL(url), init, audio);
    return new Response(`${JSON.stringify({code: 0, data: audio.toString('base64')})}\n`,
      {status: 200, headers: {'content-type': 'application/json'}});
  }}, telegram: {
    async edit(message, text, options) { edits.push({message, text, options}); }, async reply() {}, async invoke() {}, async getReply() {},
    async withClient(operation, signal) { return operation({async sendFile(peer, options) {
      const info = await fs.stat(options.file);
      sent.push({peer, options, bytes: await fs.readFile(options.file)});
      assert.ok(info.isFile());
      return {async edit(value) { sent.at(-1).edited = value; }};
    }}, signal); },
  }});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  const message = (text, extra = {}) => ({id: edits.length + 1, chatId: '9007199254740993', senderId: '1',
    outgoing: true, text, raw: {peerId: '9007199254740993', async delete(options) { deleted.push(options); }}, ...extra});
  const run = (text, extra = {}) => host.dispatchPrimary(message(text, extra));
  const listen = (text, extra = {}) => host.dispatchListeners(message(text, extra));
  return {host, root, edits, requests, sent, deleted, run, listen};
}

test('say keeps keys non-echoing and sends Volc OGG from a scoped temporary file', async t => {
  const f = await fixture(t);
  await f.run('.say key volc private-volc-token', {saved: true});
  assert.doesNotMatch(f.edits.at(-1).text, /private-volc-token/);
  await f.run('.say voice volc zh_female_test');
  await f.run('.say 你好');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url.href, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  assert.equal(f.requests[0].init.headers['X-Api-Key'], 'private-volc-token');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].options.voiceNote, true);
  assert.equal(f.sent[0].bytes.toString(), 'OggS scoped voice');
  assert.equal(f.deleted.length, 1);
  assert.deepEqual(await fs.readdir(path.join(f.root, '.temp', 'say')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
  const settings = await f.host.readSettings('say');
  assert.equal(settings.secretSet.volcKey, true);
  assert.equal(settings.values.volcKey, undefined);
});

test('say automatic mode is isolated by decimal chat-id and reloads without retained work', async t => {
  const f = await fixture(t);
  await f.run('.say key volc token', {saved: true});
  await f.run('.say on');
  await f.listen('自动语音文本');
  assert.equal(f.sent.length, 1);
  assert.equal(f.deleted.length, 1);
  const stored = JSON.parse(await fs.readFile(path.join(f.root, 'say/config.json'), 'utf8'));
  assert.equal(stored.chats['9007199254740993'], true);
  assert.equal((await f.host.unload('say', 1000)).completed, true);
  await f.host.load(create());
  assert.equal(f.host.snapshot().plugins, 1);
});

test('say falls back from the selected MiMo provider to a configured Volc provider', async t => {
  const f = await fixture(t, (url, _init, audio) => {
    if (url.hostname === 'api.xiaomimimo.com') return Response.json({error: {message: 'fixture failure'}}, {status: 503});
    return new Response(`${JSON.stringify({code: 0, data: audio.toString('base64')})}\n`, {status: 200});
  });
  await f.run('.say key mimo mimo-token', {saved: true});
  await f.run('.say key volc volc-token', {saved: true});
  await f.run('.say voice volc zh_female_test');
  await f.run('.say provider mimo');
  await f.run('.say fallback');
  assert.deepEqual(f.requests.map(item => item.url.hostname), ['api.xiaomimimo.com', 'openspeech.bytedance.com']);
  assert.equal(f.sent.length, 1);
});

test('say unload cancels an in-flight provider request without late media or deletion', async t => {
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, (_url, init) => {
    started();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true}));
  });
  await f.run('.say key volc token', {saved: true});
  await f.run('.say voice volc zh_female_test');
  const running = f.run('.say pending');
  await pending;
  const report = await f.host.unload('say', 1000);
  await running;
  assert.equal(report.completed, true);
  assert.equal(f.sent.length, 0);
  assert.equal(f.deleted.length, 0);
  assert.deepEqual(await fs.readdir(path.join(f.root, '.temp', 'say')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
});

test('say converts MiMo and Fish audio through managed FFmpeg while the scoped file exists', async t => {
  const root = await fs.mkdtemp(path.join(core, 'dist', 'mibot-say-media-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const output = path.join(root, 'media.cjs');
  esbuild.buildSync({entryPoints: [path.resolve(__dirname, '../say/v2/media.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external'});
  const {sendVoice} = require(output);
  for (const provider of ['mimo', 'fish']) {
    const scoped = path.join(root, `temp-${provider}`); await fs.mkdir(scoped);
    const sent = [], calls = [];
    const config = {schemaVersion: 1, primary: provider, speed: 1, style: '', translate: false, chats: {}, providers: {
      mimo: {apiKey: provider === 'mimo' ? 'mimo-key' : '', voice: 'voice', endpoint: 'standard'},
      volc: {apiKey: '', resourceId: 'seed-tts-2.0', voice: ''},
      fish: {apiKey: provider === 'fish' ? 'fish-key' : '', voice: 'fish-voice'},
    }};
    const controller = new AbortController();
    const context = {signal: controller.signal, log: {error() {}}, services: {available() { return false; }},
      http: {async withResponse(_url, _init, consume) {
        const source = provider === 'mimo'
          ? Response.json({choices: [{message: {audio: {data: Buffer.from('wav').toString('base64')}}}]})
          : new Response(Buffer.from('mp3'));
        return consume(source, controller.signal);
      }},
      processes: {async run(file, args, options) {
        calls.push({file, args, options});
        if (args[0] === '-version') return {stdout: Buffer.from('ffmpeg fixture')};
        await fs.writeFile(args.at(-1), Buffer.from('OggS converted')); return {stdout: Buffer.alloc(0)};
      }},
      files: {async withTemp(operation) { try { return await operation(scoped, controller.signal); }
        finally { await fs.rm(scoped, {recursive: true, force: true}); }}},
      telegram: {async withClient(operation) { return operation({async sendFile(_peer, options) {
        assert.ok((await fs.stat(options.file)).isFile()); sent.push(await fs.readFile(options.file)); return {};
      }}, controller.signal); }},
    };
    await sendVoice(context, {message: {id: 1, chatId: '1', outgoing: true, text: 'hello', raw: {peerId: 'peer'}}},
      'hello', config, async () => {});
    assert.equal(sent[0].toString(), 'OggS converted');
    assert.ok(calls.some(value => value.args.includes('libopus')));
    await assert.rejects(fs.stat(scoped), {code: 'ENOENT'});
  }
});
