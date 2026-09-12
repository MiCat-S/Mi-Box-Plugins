'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'music_hub', packageRoot: path.resolve(__dirname, '../music_hub'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function memory(initial) {
  let value = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    read: () => tail.then(() => structuredClone(value)),
    update(operation) {
      const next = tail.then(async () => {
        value = await operation(structuredClone(value));
        return structuredClone(value);
      });
      tail = next.then(() => undefined, () => undefined);
      return next;
    },
    value: () => structuredClone(value),
  };
}

function fixture(responseFor) {
  const json = memory({schemaVersion: 1, defaultSource: 'auto', br: '999', maxResults: 30,
    maxUploadBytes: 100 * 1024 * 1024, future: {kept: true}});
  const calls = [], edits = [], logs = [];
  const signal = new AbortController().signal;
  const context = {
    signal,
    storage: {json: () => json},
    http: {async withResponse(url, init, consume, policy) {
      const parsed = new URL(url);
      calls.push({url: parsed, init, policy});
      assert.equal(parsed.hostname, 'music-api.gdstudio.xyz');
      return consume(new Response(JSON.stringify(responseFor(parsed)), {
        status: 200, headers: {'content-type': 'application/json'},
      }), signal);
    }},
    files: {withTemp: () => assert.fail('private download URL must be rejected before creating a temp directory')},
    telegram: {
      async edit(message, text, options) { edits.push({message, text, options}); },
      withClient: () => assert.fail('private download URL must never reach Telegram upload'),
    },
    log: {error(event) { logs.push(event); }},
  };
  return {json, calls, edits, logs, context};
}

const invocation = (args, senderId, prefix = '!') => ({
  command: 'mh', prefix, args,
  message: {id: Math.floor(Math.random() * 1e6) + 1, chatId: '-1009007199254740993', senderId,
    outgoing: true, text: `${prefix}mh ${args.join(' ')}`},
});

test('music_hub declares both roots, ten source routes and their compatibility aliases', () => {
  const plugin = create();
  assert.deepEqual(Object.keys(plugin.commands).sort(), ['mh', 'music_hub']);
  const sourceKeys = ['netease', 'tencent', 'kuwo', 'tidal', 'qobuz', 'joox', 'bilibili', 'apple', 'ytmusic', 'spotify'];
  assert.deepEqual(sourceKeys.filter(key => plugin.commands.mh.subcommands[key]), sourceKeys);
  assert.deepEqual(plugin.commands.mh.subcommands.netease.aliases, ['wy', 'wangyi', '163']);
  assert.deepEqual(plugin.commands.mh.subcommands.tencent.aliases, ['qq', 'tx', 'tc']);
  assert.deepEqual(plugin.commands.mh.subcommands.apple.aliases, ['apple_music', 'am']);
  assert.match(plugin.renderHelp('$'), /\$mh/);
  assert.match(plugin.renderHelp('$'), /\$music_hub/);
});

test('music_hub isolates sessions by exact string IDs, uses the current prefix and rejects private media URLs', async () => {
  const f = fixture(url => {
    if (url.searchParams.get('types') === 'search') return {data: [{id: 'song-1', name: '<track>', artist: ['A&B']}]};
    return {data: {url: 'https://127.0.0.1/audio.mp3', size: 12}};
  });
  const plugin = create();
  await plugin.setup(f.context);
  const owner = '9007199254740993';
  const neighbor = '9007199254740995';
  await plugin.commands.mh.subcommands.netease.handle(invocation(['alpha'], owner), f.context);
  assert.match(f.edits.at(-1).text, /!mh 1/);
  assert.match(f.edits.at(-1).text, /&lt;track&gt;/);
  assert.match(f.edits.at(-1).text, /A&amp;B/);

  await plugin.commands.mh.handle(invocation(['1'], neighbor), f.context);
  assert.match(f.edits.at(-1).text, /没有可选择的搜索结果/);
  assert.equal(f.calls.length, 1);

  await plugin.commands.mh.handle(invocation(['1'], owner), f.context);
  assert.match(f.edits.at(-1).text, /播放链接主机不可用/);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(call => call.url.searchParams.get('types')), ['search', 'url']);
  assert.ok(f.calls.every(call => call.policy.denyPrivateAddresses === true));

  plugin.cleanup(f.context);
  await plugin.commands.mh.handle(invocation(['1'], owner), f.context);
  assert.match(f.edits.at(-1).text, /没有可选择的搜索结果/);
  assert.deepEqual(f.json.value().future, {kept: true});
});

test('music_hub validates generic MIME by signature, uploads once and cleans its temp directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'music-hub-transfer-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const json = memory({schemaVersion: 1, defaultSource: 'netease', br: '320', maxResults: 30,
    maxUploadBytes: 1024 * 1024});
  const edits = [], uploads = [], policies = [];
  let audioBytes = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
  const signal = new AbortController().signal;
  const context = {signal, storage: {json: () => json}, log: {error() {}},
    http: {async withResponse(url, _init, consume, policy) {
      policies.push(policy);
      const parsed = new URL(url);
      let body, headers = {'content-type': 'application/json'};
      if (parsed.hostname === 'cdn.example') {
        body = audioBytes;
        headers = {'content-type': 'application/octet-stream'};
      } else if (parsed.searchParams.get('types') === 'search') body = JSON.stringify({data: [{id: 'song', name: 'track', artist: ['artist']}]});
      else body = JSON.stringify({data: {url: 'https://cdn.example/audio', size: 13}});
      return consume(new Response(body, {status: 200, headers}), signal);
    }},
    files: {async withTemp(operation) {const dir = await fs.mkdtemp(path.join(root, 'run-')); try {return await operation(dir, signal);} finally {await fs.rm(dir, {recursive: true, force: true});}}},
    telegram: {edit: async (_message, text) => edits.push(text), async withClient(operation) {return operation({
      async getInputEntity(value) {return value;}, async sendFile(_peer, options) {uploads.push({size: options.file.size, bytes: await fs.readFile(options.file.path)}); return {id: 1};},
    }, signal);}},
  };
  const plugin = create();
  await plugin.commands.mh.subcommands.netease.handle(invocation(['track'], '42', '.'), context);
  await Promise.all([plugin.commands.mh.handle(invocation(['1'], '42', '.'), context), plugin.commands.mh.handle(invocation(['1'], '42', '.'), context)]);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].size, 13);
  assert.deepEqual(await fs.readdir(root), []);
  assert.ok(policies.every(policy => policy.denyPrivateAddresses === true));
  assert.ok(edits.some(text => /正在传输|请勿重复选择/.test(text)));
  audioBytes = new TextEncoder().encode('not an audio file');
  await plugin.commands.mh.subcommands.netease.handle(invocation(['track'], '42', '.'), context);
  await plugin.commands.mh.handle(invocation(['1'], '42', '.'), context);
  assert.equal(uploads.length, 1);
  assert.match(edits.at(-1), /不是支持的音频格式/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('music_hub auto mode falls back in the documented stable-source order', async () => {
  const f = fixture(url => {
    if (url.searchParams.get('source') === 'kuwo') return {data: [{id: '2', name: 'fallback', artist: 'artist'}]};
    return {data: []};
  });
  const plugin = create();
  await plugin.commands.mh.subcommands.auto.handle(invocation(['query'], '42', '.'), f.context);
  assert.deepEqual(f.calls.map(call => call.url.searchParams.get('source')), ['netease', 'kuwo']);
  assert.match(f.edits.at(-1).text, /自动选择 \(auto\).*酷我音乐 \(kuwo\)/);
});

test('music_hub settings merge concurrent partial patches without losing unknown state', async () => {
  const f = fixture(() => ({data: []}));
  const settings = create().settings(f.context);
  await Promise.all([
    settings.setValues({defaultSource: 'netease'}, f.context.signal),
    settings.setValues({br: '320'}, f.context.signal),
  ]);
  assert.equal(f.json.value().defaultSource, 'netease');
  assert.equal(f.json.value().br, '320');
  assert.deepEqual(f.json.value().future, {kept: true});
});

test('music_hub artifact loads, unloads and reloads through the real PluginHost', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'music-hub-part-3-')));
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    edit: async () => {}, reply: async () => {}, invoke: async () => {}, getReply: async () => undefined,
    withClient: async () => assert.fail('load and unload must not acquire a Telegram client'),
  }});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  await host.load(create());
  assert.equal((await host.unload('music_hub', 1000)).completed, true);
  await host.load(create());
  assert.equal((await host.unload('music_hub', 1000)).completed, true);
});
