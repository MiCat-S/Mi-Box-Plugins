'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const built = buildPlugin({id: 'tts', packageRoot: path.resolve(__dirname, '../tts'), entry: 'v2.ts'});
const create = require(path.join(built.artifactDir, 'index.cjs')).default;

async function fixture(t, responder) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-tts-v2-')));
  const edits = [], requests = [], sent = [], deleted = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {async fetch(url, init) {
    requests.push({url: new URL(url), init});
    return responder ? responder(new URL(url), init) : new Response('audio', {status: 200});
  }}, telegram: {
    async edit(message, text, options) { edits.push({message, text, options}); },
    async reply() { assert.fail('unexpected reply'); }, async invoke() { assert.fail('unexpected invoke'); },
    async getReply() { return {id: 7, text: '回复文本 🎉'}; },
    async withClient(operation, signal) { return operation({async sendFile(peer, options) { sent.push({peer, options, bytes: Buffer.isBuffer(options.file) ? options.file.length : (await fs.stat(options.file)).size}); }}, signal); },
  }});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  const run = (text, extra = {}) => host.dispatchPrimary({id: 1, chatId: '100', senderId: '1', outgoing: true, text,
    raw: {peerId: '100', async delete(options) { deleted.push(options); }}, ...extra});
  return {host, root, edits, requests, sent, deleted, run};
}

test('tts imports legacy JSON, restricts secrets to Saved Messages and redacts settings', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'tts'); await fs.mkdir(directory, {recursive: true});
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({key: 'legacy-key', region: 'eastasia', voice: 'zh-CN-YunyangNeural', style: '', rate: '1.2', format: 'audio-24khz-160kbitrate-mono-mp3'}));
  await f.run('.tts list'); assert.match(f.edits.at(-1).text, /eastasia/); assert.doesNotMatch(f.edits.at(-1).text, /legacy-key/);
  await f.run('.tts config new-secret eastus'); assert.match(f.edits.at(-1).text, /仅在收藏夹/);
  await f.run('.tts config new-secret eastus', {saved: true}); assert.doesNotMatch(f.edits.at(-1).text, /new-secret/);
  const settings = await f.host.readSettings('tts'); assert.equal(settings.secretSet.key, true); assert.equal(settings.values.key, undefined);
  const stored = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')); assert.equal(stored.schemaVersion, 1); assert.equal(stored.key, 'new-secret');
});

test('tts synthesizes replied text by streaming to a scoped file with a locked provider host', async t => {
  const f = await fixture(t, (url, init) => {
    assert.equal(url.hostname, 'eastus.tts.speech.microsoft.com'); assert.equal(url.pathname, '/cognitiveservices/v1');
    assert.equal(init.headers['Ocp-Apim-Subscription-Key'], 'test-key'); assert.match(init.body, /回复文本/); assert.doesNotMatch(init.body, /🎉/);
    return new Response(Buffer.from('voice-bytes'), {status: 200, headers: {'content-type': 'audio/mpeg'}});
  });
  await f.run('.tts config test-key eastus', {saved: true});
  await f.run('.tts', {replyToId: 7});
  assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].bytes, 11); assert.equal(f.sent[0].options.voiceNote, true);
  assert.equal(f.deleted.length, 1); assert.deepEqual(await fs.readdir(path.join(f.root, '.temp', 'tts')), []);
});

test('tts validates regions before network access and lists bounded voice data safely', async t => {
  const voices = [{ShortName: 'zh-CN-XiaoxiaoNeural', LocalName: '<晓晓>', Locale: 'zh-CN', Gender: 'Female'}];
  const f = await fixture(t, url => { assert.equal(url.pathname, '/cognitiveservices/voices/list'); return Response.json(voices); });
  await f.run('.tts config test-key not-a-region', {saved: true}); assert.match(f.edits.at(-1).text, /Region/); assert.equal(f.requests.length, 0);
  await f.run('.tts config test-key eastus', {saved: true}); await f.run('.tts voices zh-CN');
  assert.equal(f.requests.length, 1); assert.match(f.edits.at(-1).text, /XiaoxiaoNeural/); assert.match(f.edits.at(-1).text, /&lt;晓晓&gt;/);
});

test('tts loads, unloads and reloads through PluginHost without retained resources', async t => {
  const f = await fixture(t);
  assert.equal((await f.host.unload('tts', 1000)).completed, true);
  assert.equal(f.host.snapshot().plugins, 0);
  await f.host.load(create()); assert.equal(f.host.snapshot().plugins, 1);
});
