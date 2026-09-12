'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'checkin', packageRoot: path.resolve(__dirname, '../checkin'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('checkin cancels and unlocks an oversized Bot API response before falling back', async () => {
  const now = Math.floor(Date.now() / 1000), sent = [], edits = []; let cancelled = false, responseBody;
  let state = {schemaVersion: 1, runTime: '10:00', randomDelay: 0, logChat: '', botToken: 'secret', pushChatId: '123',
    targets: [{id: 'one', name: 'One', target: '@bot', command: '/sign', enabled: true}], lastRunDate: '', pending: {}, legacyImported: true};
  const signal = new AbortController().signal;
  const client = {
    async sendMessage(peer, options) {sent.push({peer, options}); return {id: peer === '@bot' ? 10 : 20};},
    async getMessages() {return [{id: 11, date: now, out: false, message: 'ok'}];},
  };
  const context = {
    signal,
    log: {error() {}},
    storage: {json: () => ({async read() {return structuredClone(state);}, async update(operation) {state = await operation(structuredClone(state)); return structuredClone(state);}})},
    http: {async withResponse(url, init, consume) {
      responseBody = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(64 * 1024 + 1));}, cancel() {cancelled = true;}});
      return consume(new Response(responseBody, {status: 200}), signal);
    }},
    telegram: {async edit(message, text) {edits.push(text);}, async withClient(operation) {return operation(client, signal);}},
  };
  await create().commands.checkin.handle({command: 'checkin', prefix: '.', args: [], message: {id: 1, chatId: '77', outgoing: true, text: '.checkin'}}, context);
  assert.equal(cancelled, true);
  assert.equal(responseBody.locked, false);
  assert.ok(sent.some(value => value.peer === '77'), 'summary falls back to the invoking chat');
  assert.match(edits.at(-1), /已执行 1 个任务/);
});

test('checkin unlocks a fully consumed Bot API response without cancelling it', async () => {
  const now = Math.floor(Date.now() / 1000); let responseBody, cancelled = false;
  let state = {schemaVersion: 1, runTime: '10:00', randomDelay: 0, logChat: '', botToken: 'secret', pushChatId: '123',
    targets: [{id: 'one', name: 'One', target: '@bot', command: '/sign', enabled: true}], lastRunDate: '', pending: {}, legacyImported: true};
  const signal = new AbortController().signal;
  const context = {signal, log: {error() {}}, storage: {json: () => ({async read() {return structuredClone(state);}, async update(operation) {state = await operation(structuredClone(state)); return structuredClone(state);}})},
    http: {async withResponse(url, init, consume) {responseBody = new ReadableStream({start(controller) {controller.enqueue(Buffer.from('{"ok":true}')); controller.close();}, cancel() {cancelled = true;}}); return consume(new Response(responseBody, {status: 200}), signal);}},
    telegram: {async edit() {}, async withClient(operation) {return operation({async sendMessage() {return {id: 10};}, async getMessages() {return [{id: 11, date: now, out: false, message: 'ok'}];}}, signal);}}};
  await create().commands.checkin.handle({command: 'checkin', prefix: '.', args: [], message: {id: 1, chatId: '77', outgoing: true, text: '.checkin'}}, context);
  assert.equal(cancelled, false);
  assert.equal(responseBody.locked, false);
});
