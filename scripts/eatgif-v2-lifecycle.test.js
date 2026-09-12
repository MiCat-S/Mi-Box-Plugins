'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'eatgif', packageRoot: path.resolve(__dirname, '../eatgif'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const sharp = require(path.join(core, 'node_modules/sharp'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const ROOT = 'https://github.com/TeleBoxOrg/TeleBox-Plugins/raw/refs/heads/main/eatgif/';

async function fixture(payloads) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eatgif-v2-'));
  const avatar = await sharp({create: {width: 8, height: 8, channels: 4, background: 'red'}}).png().toBuffer();
  const signal = new AbortController().signal, responses = [], requests = [], runs = [], edits = [], sent = [];
  const raw = {peerId: new Api.InputPeerSelf(), async delete() {this.deleted = true;}};
  const context = {
    signal, log: {error() {}},
    files: {dataPath(name) {return path.join(root, name);}, async dataFile(name) {const target = path.join(root, name); await fs.mkdir(path.dirname(target), {recursive: true}); return target;},
      async withTemp(operation) {const directory = await fs.mkdtemp(path.join(root, 'job-')); try {return await operation(directory, signal);} finally {await fs.rm(directory, {recursive: true, force: true});}}},
    http: {async withResponse(url, init, consume) {const key = String(url), payload = payloads.get(key); requests.push(key); assert.notEqual(payload, undefined, key); const response = new Response(typeof payload === 'function' ? await payload() : payload, {status: 200}); responses.push(response.body); return consume(response, signal);}},
    processes: {async run(command, args, options) {runs.push({command, args: [...args], options}); await fs.writeFile(args.at(-1), Buffer.from('webm')); return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0};}},
    telegram: {async edit(message, text) {edits.push(text);}, async getReply() {return {id: 7, senderId: '99', raw: {senderId: 99n}};}, async withClient(operation) {return operation({async getMe() {return {id: 1n};}, async downloadProfilePhoto() {return avatar;}, async sendFile(peer, options) {sent.push({peer, options});}}, signal);}},
  };
  return {root, context, responses, requests, runs, edits, sent, raw};
}

const invocation = (raw, id = 1) => ({command: 'eatgif', prefix: '.', args: ['wave'], message: {id, chatId: '1', replyToId: 7, outgoing: true, text: '.eatgif wave', raw}});

test('eatgif unlocks fixed-repository responses and rejects a remote pixel bomb before FFmpeg', async t => {
  const payloads = new Map([
    [ROOT + 'config.json', JSON.stringify({wave: {url: 'wave.json', desc: 'Wave'}})],
    [ROOT + 'wave.json', JSON.stringify({width: 64, height: 64, res: [{url: 'huge.svg'}]})],
    [ROOT + 'huge.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="4097" height="4097"><rect width="100%" height="100%"/></svg>'],
  ]);
  const f = await fixture(payloads); t.after(() => fs.rm(f.root, {recursive: true, force: true}));
  await create().commands.eatgif.handle(invocation(f.raw), f.context);
  assert.equal(f.runs.length, 0);
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1), /动图生成失败/);
  assert.ok(f.responses.every(body => body.locked === false));
});

test('eatgif validates actual frame dimensions against the remote declaration', async t => {
  const frame = await sharp({create: {width: 65, height: 64, channels: 4, background: 'blue'}}).png().toBuffer();
  const payloads = new Map([
    [ROOT + 'config.json', JSON.stringify({wave: {url: 'wave.json', desc: 'Wave'}})],
    [ROOT + 'wave.json', JSON.stringify({width: 64, height: 64, res: [{url: 'frame.png'}]})],
    [ROOT + 'frame.png', frame],
  ]);
  const f = await fixture(payloads); t.after(() => fs.rm(f.root, {recursive: true, force: true}));
  await create().commands.eatgif.handle(invocation(f.raw), f.context);
  assert.equal(f.runs.length, 0);
  assert.equal(f.sent.length, 0);
  assert.ok(f.responses.every(body => body.locked === false));
});

test('eatgif serializes atomic cache publication with clear and bounds FFmpeg files', async t => {
  const frame = await sharp({create: {width: 1, height: 1, channels: 4, background: 'green'}}).png().toBuffer();
  let releaseAsset, assetStarted;
  const started = new Promise(resolve => {assetStarted = resolve;});
  const blocked = new Promise(resolve => {releaseAsset = resolve;});
  const payloads = new Map([
    [ROOT + 'config.json', JSON.stringify({wave: {url: 'wave.json', desc: 'Wave'}})],
    [ROOT + 'wave.json', JSON.stringify({width: 1, height: 1, res: [{url: 'frame.png'}]})],
    [ROOT + 'frame.png', async () => {assetStarted(); await blocked; return frame;}],
  ]);
  const f = await fixture(payloads); t.after(() => fs.rm(f.root, {recursive: true, force: true}));
  const plugin = create(), running = plugin.commands.eatgif.handle(invocation(f.raw), f.context);
  await started;
  let cleared = false;
  const clearing = plugin.commands.eatgif.subcommands.clear.handle({command: 'eatgif', subcommand: 'clear', subcommands: ['clear'], prefix: '.', args: [], message: {id: 2, chatId: '1', outgoing: true, text: '.eatgif clear'}}, f.context).then(() => {cleared = true;});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleared, false, 'clear waits for the in-flight atomic publication');
  releaseAsset();
  await Promise.all([running, clearing]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.requests.filter(value => value.endsWith('/frame.png')).length, 1);
  assert.equal(f.runs.length, 1);
  assert.ok(f.runs[0].args.includes('-protocol_whitelist'));
  assert.equal(f.runs[0].args[f.runs[0].args.indexOf('-fs') + 1], String(20 * 1024 * 1024));
  assert.ok(f.runs[0].options.cwd.startsWith(f.root));
  assert.equal(f.runs[0].options.signal, f.context.signal);
  assert.ok(f.responses.every(body => body.locked === false));
  await assert.rejects(fs.stat(path.join(f.root, 'cache')), {code: 'ENOENT'});
  assert.deepEqual((await fs.readdir(f.root)).filter(name => name.endsWith('.tmp')), []);
});
