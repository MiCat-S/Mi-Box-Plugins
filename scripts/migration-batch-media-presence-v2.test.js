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
    processes: {concurrency: 2, queueCapacity: 16, timeoutMs: 180_000, maxOutputBytes: 2 * 1024 * 1024}, telegram: {
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
  return {edits, run: text => host.dispatchPrimary({
    id: 8, chatId: '100', senderId: '100', outgoing: true, text, ...(options.message || {}),
  })};
}

test('portball applies bounded mute rights to the replied user', async t => {
  const requests = [], sent = [];
  let deleted = 0;
  const chat = new Api.Channel({id: 10, accessHash: 11, title: 'Group', photo: new Api.ChatPhotoEmpty(), date: 0});
  const target = new Api.User({id: 20, firstName: 'Target'});
  const me = new Api.User({id: 30, firstName: 'Owner'});
  const client = {
    async getEntity(value) { return String(value) === '20' ? target : chat; },
    async getInputEntity(value) { return value; },
    async getMe() { return me; },
    async invoke(request) {
      requests.push(request);
      if (request instanceof Api.channels.GetParticipant) return {participant: request.participant instanceof Api.InputPeerSelf
        ? new Api.ChannelParticipantCreator({userId: 30}) : new Api.ChannelParticipant({userId: 20, date: 0})};
      return {};
    },
    async sendMessage(peer, value) { sent.push({peer, value}); },
  };
  const f = await fixture(t, 'portball', {client, reply: {senderId: '20'}, message: {replyToId: 7, raw: {peerId: {}, async delete() { deleted++; }}}});
  await f.run('.portball 刷屏 5m');
  const banned = requests.find(request => request instanceof Api.channels.EditBanned);
  assert.ok(banned);
  assert.equal(banned.bannedRights.sendMessages, true);
  assert.equal(banned.bannedRights.untilDate > Math.floor(Date.now() / 1000), true);
  assert.match(sent[0].value.message, /刷屏/);
  assert.equal(deleted, 1);
});

test('portball validates reply and duration before native access', async t => {
  let accessed = false;
  const f = await fixture(t, 'portball', {client: {async getEntity() { accessed = true; }}});
  await f.run('.portball 20s');
  assert.equal(accessed, false);
  assert.match(f.edits.at(-1).text, /60 秒至 366 天/);
});

test('isalive renders escaped identity, online state and last message', async t => {
  const user = new Api.User({id: 42, firstName: 'A < B', username: 'alice', premium: true, status: new Api.UserStatusOnline({expires: 0})});
  const client = {
    async getEntity() { return user; },
    async getMessages() { return [{date: 1788700000}]; },
  };
  const f = await fixture(t, 'isalive', {client, message: {raw: {peerId: {}}}});
  await f.run('.isalive alice');
  assert.match(f.edits.at(-1).text, /A &lt; B/);
  assert.match(f.edits.at(-1).text, /在线/);
  assert.match(f.edits.at(-1).text, /Premium/);
  assert.equal(f.edits.at(-1).options.parseMode, 'html');
});

test('yinglish transforms argument and reply text without exposing markup', async t => {
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  t.after(() => { Math.random = originalRandom; });
  const f = await fixture(t, 'yinglish');
  await f.run('.yinglish 你好 <b>hello</b>！');
  assert.match(f.edits.at(-1).text, /伱/);
  assert.match(f.edits.at(-1).text, /&lt;b&gt;/);
  assert.doesNotMatch(f.edits.at(-1).text, /<b>hello<\/b>/);
});

test('audio_to_voice help and missing FFmpeg paths fail locally and safely', async t => {
  const audio = {media: {}, document: {mimeType: 'audio/mpeg', attributes: []}};
  const f = await fixture(t, 'audio_to_voice', {reply: {raw: audio}, message: {replyToId: 9}});
  await f.run('.audio_to_voice');
  assert.match(f.edits.at(-1).text, /服务器已安装 FFmpeg/);
});
