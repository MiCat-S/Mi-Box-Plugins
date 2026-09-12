'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir, manifest} = buildPlugin({id: 'gif', packageRoot: path.resolve(__dirname, '../gif'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));

async function fixture({size = 4n} = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-v2-'));
  const edits = [], runs = [], sent = [];
  let state = {schemaVersion: 1, maxFileSize: 50, maxDuration: 10, maxWidth: 512, maxHeight: 512, quality: 15};
  const signal = new AbortController().signal;
  const source = {media: {document: {mimeType: 'video/mp4', size, attributes: [{className: 'DocumentAttributeVideo', duration: 1}]}},
    document: {mimeType: 'video/mp4', size, attributes: [{className: 'DocumentAttributeVideo', duration: 1}]}};
  const raw = {peerId: new Api.InputPeerSelf(), async delete() {this.deleted = true;}};
  const client = {async *iterDownload() {yield Buffer.from('data');}, async sendFile(peer, options) {
    assert.ok((await fs.stat(options.file)).isFile(), 'output exists during the scoped send'); sent.push({peer, options});
  }};
  const context = {
    signal,
    log: {error() {}},
    storage: {json: () => ({async read() {return structuredClone(state);}, async update(operation) {state = await operation(structuredClone(state)); return structuredClone(state);}})},
    files: {async withTemp(operation) {const directory = await fs.mkdtemp(path.join(temporaryRoot, 'job-')); try {return await operation(directory, signal);} finally {await fs.rm(directory, {recursive: true, force: true});}}},
    processes: {async run(command, args, options) {
      runs.push({command, args: [...args], options});
      assert.ok(path.isAbsolute(command));
      if (command.endsWith('ffprobe')) {
        const output = args.at(-1).endsWith('sticker.webm') ? {streams: [{width: 300, height: 168}], format: {duration: '1.2'}} : {streams: [{width: 640, height: 360}], format: {duration: '1.25'}};
        return {stdout: Buffer.from(JSON.stringify(output)), stderr: Buffer.alloc(0), exitCode: 0};
      }
      await fs.writeFile(args.at(-1), Buffer.from('webm'));
      return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0};
    }},
    telegram: {async edit(message, text) {edits.push(text);}, async getReply() {return {id: 7, chatId: '1', outgoing: false, text: '', raw: source};}, async withClient(operation) {return operation(client, signal);}},
  };
  return {temporaryRoot, context, edits, runs, sent, raw, state: () => state};
}

test('gif is an API 2 factory with bounded process resources', () => {
  const plugin = create();
  assert.equal(plugin.apiVersion, 2);
  assert.notEqual(plugin, create());
  assert.deepEqual(manifest.imports, ['node:fs/promises', 'node:path', 'telebox/sdk', 'teleproto']);
  assert.deepEqual(plugin.resources.processes, {concurrency: 1, queueCapacity: 1, timeoutMs: 180000, maxOutputBytes: 262144});
});

test('gif uses absolute managed helpers and removes scoped temporary files', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.temporaryRoot, {recursive: true, force: true}));
  const plugin = create(); await plugin.setup(f.context);
  await plugin.commands.gif.handle({command: 'gif', prefix: '.', args: [], message: {id: 1, chatId: '1', replyToId: 7, outgoing: true, text: '.gif', raw: f.raw}}, f.context);
  assert.equal(f.sent.length, 1);
  assert.equal(f.runs.length, 3);
  assert.ok(f.runs[0].command.endsWith('ffprobe'));
  assert.ok(f.runs[1].command.endsWith('ffmpeg'));
  assert.ok(f.runs[2].command.endsWith('ffprobe'));
  assert.equal(f.runs[0].options.maxOutputBytes, 4096);
  assert.equal(f.runs[1].options.timeoutMs, 180000);
  assert.ok(f.runs.every(value => value.args.includes('-protocol_whitelist') && value.args.includes('file')));
  assert.ok(f.runs.every(value => value.options.cwd.startsWith(f.temporaryRoot)));
  assert.equal(f.runs[1].args[f.runs[1].args.indexOf('-fs') + 1], String(2 * 1024 * 1024));
  const video = f.sent[0].options.attributes.find(value => value instanceof Api.DocumentAttributeVideo);
  assert.deepEqual({width: video.w, height: video.h}, {width: 300, height: 168});
  assert.ok(f.sent[0].options.attributes.some(value => value instanceof Api.DocumentAttributeAnimated));
  assert.ok(f.sent[0].options.attributes.some(value => value instanceof Api.DocumentAttributeSticker));
  assert.equal(f.raw.deleted, true);
  assert.deepEqual(await fs.readdir(f.temporaryRoot), []);
});

test('gif rejects an oversized declared file before temp files or processes are used', async t => {
  const f = await fixture({size: 51n * 1024n * 1024n}); t.after(() => fs.rm(f.temporaryRoot, {recursive: true, force: true}));
  await create().commands.gif.handle({command: 'gif', prefix: '.', args: [], message: {id: 1, chatId: '1', replyToId: 7, outgoing: true, text: '.gif', raw: f.raw}}, f.context);
  assert.equal(f.runs.length, 0);
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1), /文件超过配置上限/);
  assert.deepEqual(await fs.readdir(f.temporaryRoot), []);
});

test('gif loads, unloads, and reloads through the real PluginHost', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gif-host-')));
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit() {}, async reply() {}, async invoke() {}, async getReply() {}, async withClient(operation, signal) {return operation({}, signal);},
  }, processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 180000, maxOutputBytes: 262144}});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  await host.load(create());
  assert.equal((await host.unload('gif', 1000)).completed, true);
  await host.load(create());
  assert.equal((await host.unload('gif', 1000)).completed, true);
});

test('gif does not expose file-system paths from unknown helper failures', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.temporaryRoot, {recursive: true, force: true}));
  f.context.processes.run = async (command, args) => {
    if (command.endsWith('ffprobe')) return {stdout: Buffer.from(JSON.stringify({streams: [{width: 640, height: 360}], format: {duration: '1.25'}})), stderr: Buffer.alloc(0), exitCode: 0};
    throw new Error(`/private/secret/${path.basename(args.at(-1))}`);
  };
  await create().commands.gif.handle({command: 'gif', prefix: '.', args: [], message: {id: 1, chatId: '1', replyToId: 7, outgoing: true, text: '.gif', raw: f.raw}}, f.context);
  assert.match(f.edits.at(-1), /转换失败：请检查媒体格式和 FFmpeg/);
  assert.doesNotMatch(f.edits.at(-1), /private|secret/);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await fs.readdir(f.temporaryRoot), []);
});
