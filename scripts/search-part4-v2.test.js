'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const create = require(path.join(buildPlugin({id: 'search', packageRoot: path.resolve(__dirname, '../search'), entry: 'v2.ts'}).artifactDir, 'index.cjs')).default;

test('search atomically deduplicates concurrent channel additions', async () => {
  let data = {schemaVersion: 1, defaultChannel: null, channelList: [], adFilters: []};
  let tail = Promise.resolve();
  const edits = [];
  const signal = new AbortController().signal;
  const store = {async read() {return structuredClone(data);}, update(change) {
    const operation = tail.then(async () => {data = await change(structuredClone(data)); return structuredClone(data);});
    tail = operation.then(() => undefined, () => undefined); return operation;
  }};
  const client = {async getEntity(value) {return {className: 'Channel', title: String(value), megagroup: true};}};
  const context = {signal, log: {error() {}}, storage: {json() {return store;}}, telegram: {async edit(_message, text) {edits.push(text);},
    async withClient(operation) {return operation(client, signal);}}};
  const invoke = () => create().commands.so.handle({command: 'so', prefix: '.', args: ['add', '@same'],
    message: {id: 1, chatId: '1', text: '.so add @same', outgoing: true}}, context);
  await Promise.all([invoke(), invoke()]);
  assert.deepEqual(data.channelList.map(item => item.handle), ['@same']);
  assert.equal(data.defaultChannel, '@same');
  assert.equal(edits.filter(value => value.includes('成功添加 1')).length, 1);
  assert.equal(edits.filter(value => value.includes('成功添加 0')).length, 1);
});

test('search validates a default channel against the state inside the atomic update', async () => {
  let data = {schemaVersion: 1, defaultChannel: null, channelList: [{title: 'A', handle: '@a'}], adFilters: []};
  const edits = [];
  const signal = new AbortController().signal;
  let beforeUpdate = true;
  const context = {signal, log: {error() {}}, storage: {json() {return {async read() {return structuredClone(data);}, async update(change) {
    if (beforeUpdate) {beforeUpdate = false; data.channelList = [];}
    data = await change(structuredClone(data)); return data;
  }};}}, telegram: {async edit(_message, text) {edits.push(text);}}};
  await create().commands.so.handle({command: 'so', prefix: '.', args: ['default', '@a'],
    message: {id: 1, chatId: '1', text: '.so default @a', outgoing: true}}, context);
  assert.equal(data.defaultChannel, null);
  assert.match(edits.at(-1), /请先使用 so add/);
});
