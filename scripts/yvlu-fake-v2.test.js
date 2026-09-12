'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'yvlu', packageRoot: path.resolve(__dirname, '../yvlu'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(text, {deleteFails = false} = {}) {
  const payloads = [], sent = [], edits = [], logs = [];
  const controller = new AbortController();
  const parent = {id: 6, peerId: 'peer', message: 'parent text', entities: [], sender: {id: 3n, firstName: 'Parent'}};
  const replied = {id: 7, peerId: 'peer', message: 'original text', entities: [],
    media: /^\.yvlu fr?\s/.test(text) ? {photo: {}} : undefined, sender: {id: 1n, firstName: 'Original'},
    isReply: true, replyTo: {replyToMsgId: 6, quote: true, quoteText: 'partial parent', quoteEntities: []}};
  const fakeSender = {id: 9007199254740995n, firstName: 'Fake', lastName: 'Sender', username: 'fake', emojiStatus: {documentId: 8n}};
  const client = {
    async getEntity(value) { return value === '@fake' || value === fakeSender ? fakeSender : value; },
    async sendFile(peer, options) { sent.push({peer, options}); },
    async deleteMessages() { if (deleteFails) throw new Error('private cleanup detail'); },
  };
  const context = {
    signal: controller.signal,
    log: {info() {}, error(event) { logs.push(event); }},
    telegram: {
      async edit(_message, value) { edits.push(value); },
      async getReply(message) {
        if (message.id === 1) return {id: 7, chatId: '1', text: replied.message, raw: replied};
        if (message.id === 7) return {id: 6, chatId: '1', text: parent.message, raw: parent};
      },
      async withClient(operation) { return operation(client, controller.signal); },
    },
    http: {async withResponse(_url, init, operation) {
      payloads.push(JSON.parse(init.body));
      return operation(new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        {status: 200, headers: {'content-type': 'image/png'}}), controller.signal);
    }},
  };
  await create().commands.yvlu.handle({command: 'yvlu', prefix: '.', args: text.split(/\s+/).slice(1),
    message: {id: 1, chatId: '1', outgoing: true, replyToId: 7, text, raw: {peerId: 'peer', entities: []}}}, context);
  return {payload: payloads[0], sent, edits, logs};
}

test('yvlu f/fr preserve the original sender while replacing text and optionally keeping the reply', async () => {
  const fake = await fixture('.yvlu f forged text');
  assert.equal(String(fake.payload.messages[0].from.id), '1');
  assert.equal(fake.payload.messages[0].text, 'forged text');
  assert.equal('media' in fake.payload.messages[0], false);
  assert.equal('replyMessage' in fake.payload.messages[0], false);
  const withReply = await fixture('.yvlu fr forged reply');
  assert.equal(withReply.payload.messages[0].text, 'forged reply');
  assert.equal(withReply.payload.messages[0].replyMessage.text, 'partial parent');
});

test('yvlu u/ur preserve the original text while replacing the sender with exact IDs', async () => {
  const fake = await fixture('.yvlu u @fake');
  assert.equal(fake.payload.messages[0].from.id, '9007199254740995');
  assert.equal(fake.payload.messages[0].from.first_name, 'Fake');
  assert.equal(fake.payload.messages[0].text, 'original text');
  const withReply = await fixture('.yvlu ur @fake');
  assert.equal(withReply.payload.messages[0].replyMessage.text, 'partial parent');
});

test('yvlu keeps a successful fake quote when command cleanup fails', async () => {
  const result = await fixture('.yvlu f delivered once', {deleteFails: true});
  assert.equal(result.sent.length, 1);
  assert.deepEqual(result.logs, ['yvlu.receipt_cleanup_failed']);
  assert.match(result.edits.at(-1), /语录已生成/);
  assert.doesNotMatch(result.edits.join('\n'), /语录操作失败|private cleanup detail/);
});

test('yvlu help explicitly documents all legacy fake modes', () => {
  const help = create().renderHelp('!');
  for (const value of ['!yvlu f 伪造消息', '!yvlu fr 伪造消息', '!yvlu u 用户ID/用户名', '!yvlu ur 用户ID/用户名']) {
    assert.ok(help.includes(value), value);
  }
});
