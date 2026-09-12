'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'dme', packageRoot: path.resolve(__dirname, '../dme'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));

test('dme cancels and unlocks an oversized anti-revoke image before caching or upload', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dme-http-')); t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const signal = new AbortController().signal; let requested = false, cancelled = false, responseBody, pages = 0, uploaded = false; const deleted = [], logs = [];
  const chat = {className: 'Chat', id: 77n, noforwards: true};
  const client = {
    async getMe() {return {id: 1n};}, async getEntity() {return chat;},
    async deleteMessages(peer, ids) {deleted.push(...ids);}, async uploadFile() {uploaded = true; return {};}, async sendMessage() {return {id: 20};},
    async invoke(request) {
      if (request instanceof Api.messages.GetHistory) {
        if (pages++) return {messages: []};
        return {messages: [{className: 'Message', id: 9, out: true, date: Math.floor(Date.now() / 1000), media: {className: 'MessageMediaPhoto'}}]};
      }
      if (request instanceof Api.updates.GetState) return {};
      throw new Error(`unexpected request ${request.className}`);
    },
  };
  const context = {
    signal,
    log: {info(event, fields) {logs.push({event, fields});}, error(event, fields) {logs.push({event, fields});}},
    tasks: {async run(label, operation) {return operation(signal);}},
    files: {async dataFile(name) {return path.join(directory, name);}, dataPath(name) {return path.join(directory, name);}},
    storage: {json: () => ({async read() {return {batchSize: 50, searchLimit: 100, retryAttempts: 0};}, async update(operation) {return operation({batchSize: 50, searchLimit: 100, retryAttempts: 0});}})},
    http: {async withResponse(url, init, consume) {
      requested = true;
      responseBody = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));}, cancel() {cancelled = true;}});
      return consume(new Response(responseBody, {status: 200}), signal);
    }},
    telegram: {async edit() {}, async withClient(operation) {return operation(client, signal);}},
  };
  await create().commands.dme.handle({command: 'dme', prefix: '.', args: ['-f', '1'], message: {id: 10, chatId: '-77', outgoing: true, text: '.dme -f 1', raw: {peerId: chat}}}, context);
  assert.equal(requested, true, JSON.stringify({logs, deleted, pages, edits: []}));
  assert.equal(cancelled, true);
  assert.equal(responseBody.locked, false);
  assert.equal(uploaded, false);
  assert.ok(deleted.includes(9));
  assert.deepEqual(await fs.readdir(directory), []);
});

test('dme removes an oversized cache before reading and replaces it atomically', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dme-cache-')); t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const cache = path.join(directory, 'dme_troll_image.png');
  await fs.writeFile(cache, Buffer.alloc(5 * 1024 * 1024 + 1));
  const signal = new AbortController().signal; let requested = 0, pages = 0, uploaded = 0;
  const chat = {className: 'Chat', id: 77n, noforwards: true};
  const client = {
    async getMe() {return {id: 1n};}, async getEntity() {return chat;}, async deleteMessages() {},
    async uploadFile() {uploaded++; return {};}, async sendMessage() {return {id: 20};},
    async invoke(request) {
      if (request instanceof Api.messages.GetHistory) {
        if (pages++) return {messages: []};
        return {messages: [{className: 'Message', id: 9, out: true, date: Math.floor(Date.now() / 1000), media: {className: 'MessageMediaPhoto'}}]};
      }
      if (request instanceof Api.messages.EditMessage || request instanceof Api.updates.GetState) return {};
      throw new Error(`unexpected request ${request.className}`);
    },
  };
  let responseBody;
  const context = {
    signal, log: {info() {}, error() {}}, tasks: {async run(label, operation) {return operation(signal);}},
    files: {async dataFile(name) {return path.join(directory, name);}, dataPath(name) {return path.join(directory, name);}},
    storage: {json: () => ({async read() {return {batchSize: 50, searchLimit: 100, retryAttempts: 0};}, async update(operation) {return operation({batchSize: 50, searchLimit: 100, retryAttempts: 0});}})},
    http: {async withResponse(url, init, consume) {requested++; responseBody = new ReadableStream({start(controller) {controller.enqueue(Buffer.from('replacement')); controller.close();}}); return consume(new Response(responseBody, {status: 200}), signal);}},
    telegram: {async edit() {}, async withClient(operation) {return operation(client, signal);}},
  };
  await create().commands.dme.handle({command: 'dme', prefix: '.', args: ['-f', '1'], message: {id: 10, chatId: '-77', outgoing: true, text: '.dme -f 1', raw: {peerId: chat}}}, context);
  assert.equal(requested, 1);
  assert.equal(uploaded, 1);
  assert.equal((await fs.readFile(cache)).toString(), 'replacement');
  assert.equal(responseBody.locked, false);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});
