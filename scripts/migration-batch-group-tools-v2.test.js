'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

function load(id) {
  const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, `../${id}`), entry: 'v2.ts'});
  return require(path.join(artifactDir, 'index.cjs')).default;
}

async function fixture(t, id, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mibot-${id}-v2-`)));
  const edits = [];
  const client = options.client || {};
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}},
    ...(options.fetch ? {http: {fetch: options.fetch}} : {}), telegram: {
      async edit(message, text, messageOptions) { edits.push({message, text, options: messageOptions}); },
      async reply() { assert.fail('unexpected reply'); },
      async invoke(request) { return client.invoke(request); },
      async getReply() { return options.reply; },
      async withClient(operation, signal) { return operation(client, signal); },
    }});
  await host.load(load(id)());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {edits, run: (text, message = {}) => host.dispatchPrimary({
    id: 7, chatId: '123', senderId: '123', outgoing: true, text, ...message,
  })};
}

test('oxost uploads replied media with expiry and secret fields', async t => {
  const requests = [];
  const raw = {media: {}, document: {attributes: [{fileName: 'report.pdf'}]}, async downloadMedia() { return Buffer.from('document'); }};
  const f = await fixture(t, 'oxost', {reply: {raw}, fetch: async (url, init) => {
    requests.push({url: String(url), init});
    return new Response('https://0x0.st/file.pdf\n');
  }});
  await f.run('.0x0 expires=72 secret', {replyToId: 6});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.body.get('expires'), '72');
  assert.equal(requests[0].init.body.get('secret'), '1');
  assert.match(f.edits.at(-1).text, /https:\/\/0x0\.st\/file\.pdf/);
});

test('oxost rejects unsupported arguments before reading the reply', async t => {
  let requested = false;
  const f = await fixture(t, 'oxost', {fetch: async () => { requested = true; return new Response(''); }});
  await f.run('.0x0 expires=0', {replyToId: 6});
  assert.equal(requested, false);
  assert.match(f.edits.at(-1).text, /0x0\.st 文件上传/);
});

test('premium counts users while filtering bots and deleted accounts', async t => {
  const chat = new Api.Chat({id: 1, title: 'Group', participantsCount: 4});
  const users = [
    new Api.User({id: 1, firstName: 'A', premium: true}),
    new Api.User({id: 2, firstName: 'B'}),
    new Api.User({id: 3, firstName: 'Bot', bot: true}),
    new Api.User({id: 4, firstName: 'Gone', deleted: true}),
  ];
  const client = {async getEntity() { return chat; }, async *iterParticipants() { yield* users; }};
  const f = await fixture(t, 'premium', {client});
  await f.run('.premium', {raw: {peerId: {}}});
  assert.match(f.edits.at(-1).text, /Premium：<b>1<\/b> \/ 2（<b>50\.00%<\/b>）/);
  assert.match(f.edits.at(-1).text, /过滤 Bot 1 · 已注销 1/);
});

test('atall sends escaped mentions and deletes the command receipt', async t => {
  const sent = [];
  let deleted = 0;
  const client = {
    async getParticipants() { return [
      new Api.User({id: 1, firstName: 'A < B'}),
      new Api.User({id: 2, username: 'public_user'}),
      new Api.User({id: 3, bot: true}),
    ]; },
    async sendMessage(peer, value) { sent.push({peer, value}); },
  };
  const f = await fixture(t, 'atall', {client});
  await f.run('.atall', {raw: {peerId: {}, async delete() { deleted++; }}});
  assert.equal(sent.length, 1);
  assert.match(sent[0].value.message, /A &lt; B/);
  assert.match(sent[0].value.message, /@public_user/);
  assert.equal(deleted, 1);
});

test('atadmins uses Telegram admin filtering and sends custom text', async t => {
  const sent = [];
  let filter;
  const client = {
    async getParticipants(peer, options) {
      filter = options.filter;
      return [new Api.User({id: 4, firstName: 'Admin <One>'}), new Api.User({id: 5, bot: true})];
    },
    async sendMessage(peer, value) { sent.push({peer, value}); },
  };
  const f = await fixture(t, 'atadmins', {client});
  await f.run('.atadmins 请处理', {raw: {peerId: {}, async delete() {}}});
  assert.equal(filter instanceof Api.ChannelParticipantsAdmins, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].value.message, /请处理/);
  assert.match(sent[0].value.message, /Admin &lt;One&gt;/);
});
