'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir, manifest} = buildPlugin({id: 'eat', packageRoot: path.resolve(__dirname, '../eat'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const sharp = require(path.join(core, 'node_modules/sharp'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));

async function fixture(options = {}) {
  const target = options.target ?? await sharp({create: {width: 32, height: 32, channels: 4, background: {r: 30, g: 60, b: 90, alpha: 1}}}).png().toBuffer();
  const base = await sharp({create: {width: 64, height: 64, channels: 4, background: {r: 240, g: 240, b: 240, alpha: 1}}}).png().toBuffer();
  const mask = await sharp({create: {width: 24, height: 24, channels: 4, background: {r: 255, g: 255, b: 255, alpha: 1}}}).png().toBuffer();
  const catalog = Buffer.from(JSON.stringify({resources: {test: {name: '测试', url: 'eat/base.png', you: {x: -2, y: 3, mask: 'eat/mask.png'}}}}));
  const responses = new Map([
    ['https://raw.githubusercontent.com/TeleBoxOrg/TeleBox-Plugins/refs/heads/main/eat/config.json', catalog],
    ['https://raw.githubusercontent.com/TeleBoxOrg/TeleBox-Plugins/refs/heads/main/eat/base.png', base],
    ['https://raw.githubusercontent.com/TeleBoxOrg/TeleBox-Plugins/refs/heads/main/eat/mask.png', mask],
  ]);
  const requests = [], responseBodies = [], sent = [], edits = [];
  let state = {schemaVersion: 1, sourceUrl: [...responses.keys()][0]};
  const signal = new AbortController().signal;
  const replyRaw = {senderId: 99n, media: {document: {mimeType: 'image/png', size: BigInt(target.length)}}};
  const commandRaw = {peerId: new Api.InputPeerSelf(), async delete() {this.deleted = true;}};
  const client = {
    async *iterDownload() {yield target;},
    async sendFile(peer, options) {sent.push({peer, options});},
  };
  const context = {
    signal,
    log: {error() {}},
    storage: {json: () => ({
      async read() {return structuredClone(state);},
      async update(operation) {state = await operation(structuredClone(state)); return structuredClone(state);},
    })},
    http: {async withResponse(url, init, consume) {
      const key = String(url); requests.push({key, init}); const body = responses.get(key); assert.ok(body, key);
      const response = new Response(body, {status: 200, headers: {'content-type': key.endsWith('.json') ? 'application/json' : 'image/png'}});
      responseBodies.push(response.body);
      return consume(response, signal);
    }},
    telegram: {
      async edit(message, text, options) {edits.push({message, text, options});},
      async getReply() {return {id: 7, chatId: '1', senderId: '99', outgoing: false, text: '', raw: replyRaw};},
      async withClient(operation) {return operation(client, signal);},
    },
  };
  return {context, requests, responseBodies, sent, edits, commandRaw, state: () => state};
}

test('eat is an API 2 factory and declares only supported runtime imports', () => {
  assert.equal(create().apiVersion, 2);
  assert.notEqual(create(), create());
  assert.deepEqual(Object.keys(create().commands), ['eat', 'eat2']);
  assert.deepEqual(manifest.imports, ['sharp', 'telebox/sdk', 'teleproto', 'teleproto/client/uploads.js']);
});

test('eat2 validates bounded HTTP assets, caches them per instance, and sends a sticker', async () => {
  const f = await fixture(), plugin = create();
  await plugin.setup(f.context);
  const invocation = {command: 'eat2', prefix: '.', args: ['test'], message: {id: 1, chatId: '1', replyToId: 7, outgoing: true, text: '.eat2 test', raw: f.commandRaw}};
  await plugin.commands.eat2.handle(invocation, f.context);
  assert.equal(f.requests.length, 3);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].options.file.name, 'eat.webp');
  assert.ok(f.sent[0].options.file.size > 0 && f.sent[0].options.file.size <= 512 * 1024);
  assert.ok(f.sent[0].options.attributes.some(value => value instanceof Api.DocumentAttributeSticker));
  assert.equal(f.commandRaw.deleted, true);
  assert.ok(f.responseBodies.every(body => body.locked === false));
  f.commandRaw.deleted = false;
  await plugin.commands.eat2.handle(invocation, f.context);
  assert.equal(f.requests.length, 3, 'configuration and image assets remain in the instance cache');
  await plugin.cleanup(f.context);
  await plugin.commands.eat2.handle(invocation, f.context);
  assert.equal(f.requests.length, 6, 'cleanup drops both configuration and asset caches');
  assert.ok(f.responseBodies.every(body => body.locked === false));
});

test('eat rejects a small compressed image above the exact pixel budget', async () => {
  const target = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4097" height="4097"><rect width="100%" height="100%" fill="red"/></svg>');
  const f = await fixture({target});
  await create().commands.eat2.handle({command: 'eat2', prefix: '.', args: ['test'], message: {id: 1, chatId: '1', replyToId: 7, outgoing: true, text: '.eat2 test', raw: f.commandRaw}}, f.context);
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1).text, /生成失败/);
  assert.ok(f.responseBodies.every(body => body.locked === false));
});

test('eat rejects non-GitHub configuration URLs before any HTTP request', async () => {
  const f = await fixture(), plugin = create();
  await plugin.commands.eat.subcommands.set.handle({command: 'eat', subcommand: 'set', subcommands: ['set'], prefix: '.', args: ['https://example.com/config.json'], message: {id: 1, chatId: '1', outgoing: true, text: '.eat set https://example.com/config.json'}}, f.context);
  assert.equal(f.requests.length, 0);
  assert.match(f.edits.at(-1).text, /仅支持 GitHub/);
});

test('eat loads, unloads, and reloads through the real PluginHost', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'eat-host-')));
  const output = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(message, text) {output.push(text);}, async reply(message, text) {output.push(text);}, async invoke() {}, async getReply() {}, async withClient(operation, signal) {return operation({}, signal);},
  }});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  await host.load(create());
  await host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text: '.eat2 help'});
  assert.match(output.join('\n'), /\.eat2/);
  assert.match(output.join('\n'), /回复图片或静态贴纸/);
  assert.match(output.join('\n'), /\.eat /);
  assert.equal((await host.unload('eat', 1000)).completed, true);
  await host.load(create());
  assert.equal((await host.unload('eat', 1000)).completed, true);
});
