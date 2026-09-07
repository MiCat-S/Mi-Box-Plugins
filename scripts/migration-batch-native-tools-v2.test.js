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

async function fixture(t, id, client, message = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mibot-${id}-v2-`)));
  const edits = [], replies = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(envelope, text, options) { edits.push({envelope, text, options}); },
    async reply(envelope, text, options) { replies.push({envelope, text, options}); },
    async invoke(request) { return client.invoke(request); },
    async getReply() { return undefined; },
    async withClient(operation, signal) { return operation(client, signal); },
  }});
  await host.load(load(id)());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {edits, replies, run: text => host.dispatchPrimary({
    id: 20, chatId: '100', senderId: '100', outgoing: true, text, ...message,
  })};
}

test('dbdj samples unique valid recent speakers and deletes its command', async t => {
  let deleted = 0;
  const entities = new Map([
    ['1', new Api.User({id: 1, firstName: 'Alice'})],
    ['2', new Api.User({id: 2, username: 'bob'})],
    ['3', new Api.User({id: 3, firstName: 'Bot', bot: true})],
  ]);
  const client = {
    async getMessages() { return [1, 2, 1, 3].map(id => new Api.Message({id, peerId: new Api.PeerUser({userId: id}), fromId: new Api.PeerUser({userId: id}), message: 'x'})); },
    async getEntity(id) { return entities.get(String(id)); },
  };
  const f = await fixture(t, 'dbdj', client, {raw: {peerId: {}, async delete() { deleted++; }}});
  await f.run('.dbdj 50 2 恭喜');
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0].text, /有效 2 人 · 选中 2 人/);
  assert.match(f.replies[0].text, /恭喜/);
  assert.equal(deleted, 1);
});

test('netease sends a direct media response returned by Music163bot', async t => {
  const sent = [], files = [];
  let deleted = 0;
  const media = {kind: 'audio'};
  const client = {
    async invoke() { return {}; },
    async sendMessage(peer, value) { sent.push({peer, value}); },
    async getMessages() { return [{id: 9, out: false, date: Math.floor(Date.now() / 1000), media, message: 'Song via @Music163bot'}]; },
    async sendFile(peer, value) { files.push({peer, value}); },
  };
  const f = await fixture(t, 'netease', client, {raw: {peerId: {}, async delete() { deleted++; }}});
  await f.run('.netease 12345');
  assert.equal(sent.some(item => item.peer === 'Music163bot' && item.value.message === '/music 12345'), true);
  assert.equal(files.length, 1);
  assert.equal(files[0].value.file, media);
  assert.equal(files[0].value.caption, 'Song');
  assert.equal(deleted, 1);
});

test('clear_sticker deletes only sticker documents from history', async t => {
  const deleted = [];
  const sticker = new Api.Message({id: 4, peerId: new Api.PeerChannel({channelId: 1}), message: '', media: new Api.MessageMediaDocument({
    document: new Api.Document({id: 1, accessHash: 1, fileReference: Buffer.alloc(0), date: 0, mimeType: 'image/webp', size: 1,
      dcId: 1, attributes: [new Api.DocumentAttributeSticker({alt: 'x', stickerset: new Api.InputStickerSetEmpty()})]}),
  })});
  const plain = new Api.Message({id: 3, peerId: new Api.PeerChannel({channelId: 1}), message: 'plain'});
  const client = {
    async invoke() { return {messages: [sticker, plain]}; },
    async deleteMessages(peer, ids) { deleted.push(...ids); },
  };
  const f = await fixture(t, 'clear_sticker', client, {raw: {peerId: {}}});
  await f.run('.clear_sticker 10');
  assert.deepEqual(deleted, [4]);
  assert.match(f.edits.at(-1).text, /共删除 1 条/);
});

test('restore_pin restores unique unpinned messages from the admin log', async t => {
  const pinned = [];
  const chat = new Api.Channel({id: 1, accessHash: 2, title: 'Group', photo: new Api.ChatPhotoEmpty(), date: 0});
  const eventMessage = new Api.Message({id: 55, peerId: new Api.PeerChannel({channelId: 1}), message: '', pinned: false});
  const client = {
    async getEntity() { return chat; },
    async getMe() { return new Api.User({id: 9, firstName: 'Owner'}); },
    async invoke(request) {
      if (request instanceof Api.channels.GetParticipant) return {participant: new Api.ChannelParticipantCreator({userId: 9})};
      if (request instanceof Api.channels.GetAdminLog) return {events: [{action: new Api.ChannelAdminLogEventActionUpdatePinned({message: eventMessage})}]};
      if (request instanceof Api.messages.UpdatePinnedMessage) { pinned.push(request.id); return {}; }
      throw new Error('unexpected request');
    },
  };
  const f = await fixture(t, 'restore_pin', client, {raw: {peerId: {}}});
  await f.run('.restore_pin');
  assert.deepEqual(pinned, [55]);
  assert.match(f.edits.at(-1).text, /成功 1 · 失败 0/);
});
