'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'yvlu', packageRoot: path.resolve(__dirname, '../yvlu'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('yvlu emits unsafe-range Telegram ids as exact decimal strings in the quote payload', async () => {
  const precise = 9007199254740995n;
  let payload;
  const sent = [], deleted = [], edits = [];
  const controller = new AbortController();
  const replied = {id: 7, chatId: '1', message: 'quoted text', senderId: precise, peerId: 'peer',
    sender: {id: precise, firstName: 'Precise', lastName: 'User'}, entities: []};
  const client = {
    async getEntity(value) { return value; },
    async sendFile(peer, options) { sent.push({peer, options}); },
    async deleteMessages(peer, ids, options) { deleted.push({peer, ids, options}); },
  };
  const context = {signal: controller.signal, log: {info() {}, error() {}}, telegram: {
    async edit(_message, text) { edits.push(text); },
    async getReply() { return {id: 7, chatId: '1', senderId: precise.toString(), text: 'quoted text', raw: replied}; },
    async withClient(operation) { return operation(client, controller.signal); },
  }, http: {async withResponse(url, init, operation) {
    assert.equal(url, 'https://quote-api-enhanced.zhetengsha.eu.org/generate.webp');
    payload = JSON.parse(init.body);
    return operation(new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      {status: 200, headers: {'content-type': 'image/png'}}), controller.signal);
  }}};
  const plugin = create();
  await plugin.commands.yvlu.handle({command: 'yvlu', prefix: '.', args: [], message: {id: 1, chatId: '1', outgoing: true,
    replyToId: 7, text: '.yvlu', raw: {peerId: 'peer'}}}, context);
  assert.equal(payload.messages[0].from.id, precise.toString());
  assert.equal(typeof payload.messages[0].from.id, 'string');
  assert.equal(sent.length, 1);
  assert.deepEqual(deleted[0].ids, [1]);
  assert.match(edits[0], /正在生成/);
});
