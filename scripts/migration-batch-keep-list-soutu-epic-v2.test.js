'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

function load(id) {
  const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, `../${id}`), entry: 'v2.ts'});
  return require(path.join(artifactDir, 'index.cjs')).default;
}

async function fixture(t, id, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mibot-${id}-v2-`)));
  const edits = [], sent = [], invokes = [];
  const telegram = {
    async edit(message, text, messageOptions) { edits.push({message, text, options: messageOptions}); },
    async reply() { assert.fail('unexpected reply'); },
    async invoke(request) { invokes.push(request); return options.invoke ? options.invoke(request) : {}; },
    async getReply() { return options.reply; },
    async withClient(operation, signal) {
      return operation({
        async getMe() { return {id: 1}; },
        async sendMessage(peer, value) { sent.push({peer, value}); },
      }, signal);
    },
  };
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram,
    ...(options.fetch ? {http: {fetch: options.fetch}} : {})});
  await host.load(load(id)());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {root, edits, sent, invokes, run: text => host.dispatchPrimary({
    id: 1, chatId: '123', senderId: '123', outgoing: true, text,
    ...(options.message || {}),
  })};
}

test('keep_online exposes a tracked scheduled probe and status command', async t => {
  const create = load('keep_online');
  const plugin = create();
  assert.equal(plugin.jobs.keep_online.cron, '55 * * * * *');
  assert.equal(plugin.commands.keep_online.description.includes('在线'), true);
  const f = await fixture(t, 'keep_online');
  await f.run('.keep_online');
  assert.match(f.edits.at(-1).text, /等待首次探测/);
  assert.equal(f.edits.at(-1).options.parseMode, 'html');
});

test('listusernames renders escaped public chats and channel statistics', async t => {
  const f = await fixture(t, 'listusernames', {invoke: async () => ({chats: [
    {id: 100, title: 'A < B', username: 'public_one', broadcast: true},
    {id: 200, title: 'Group', username: 'public_two', broadcast: false},
  ]})});
  await f.run('.listusernames');
  assert.equal(f.invokes.length, 1);
  assert.match(f.edits.at(-1).text, /A &lt; B/);
  assert.match(f.edits.at(-1).text, /频道 1 · 群组 1 · 总计 2/);
  assert.equal(f.edits.at(-1).options.parseMode, 'html');
});

test('listusernames handles an empty result without exposing runtime details', async t => {
  const f = await fixture(t, 'listusernames', {invoke: async () => ({chats: []})});
  await f.run('.listusernames');
  assert.match(f.edits.at(-1).text, /没有找到/);
});

test('soutu uploads a replied photo and emits both reverse-search links', async t => {
  const requests = [];
  const photo = Buffer.from('ffd8ffe000104a464946', 'hex');
  const f = await fixture(t, 'soutu', {
    message: {replyToId: 9},
    reply: {raw: {photo: {}, async downloadMedia({outputFile}) { await fs.writeFile(outputFile, photo); return outputFile; }}},
    fetch: async (url, init) => {
      requests.push({url: String(url), init});
      assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()), photo);
      return new Response('https://0x0.st/example.jpg\n');
    },
  });
  await f.run('.soutu');
  assert.equal(new URL(requests[0].url).origin, 'https://0x0.st');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.body instanceof FormData, true);
  assert.match(f.edits.at(-1).text, /Google Lens/);
  assert.match(f.edits.at(-1).text, /Yandex Images/);
  assert.equal(f.edits.at(-1).options.linkPreview, false);
});

test('soutu requires a replied photo and makes no network request otherwise', async t => {
  let requested = false;
  const f = await fixture(t, 'soutu', {fetch: async () => { requested = true; return new Response(''); }});
  await f.run('.soutu');
  assert.equal(requested, false);
  assert.match(f.edits.at(-1).text, /请先回复一张图片/);
});

test('epic renders current free games and escapes remote content', async t => {
  const f = await fixture(t, 'epic', {fetch: async () => Response.json({data: {Catalog: {searchStore: {elements: [{
    title: 'Game <One>', description: 'Fun & free', categories: [{path: 'freegames'}],
    price: {totalPrice: {discountPrice: 0, fmtPrice: {originalPrice: '¥68'}}},
    promotions: {promotionalOffers: [{promotionalOffers: [{startDate: '2026-09-01T00:00:00Z', endDate: '2026-09-08T00:00:00Z'}]}]},
    offerMappings: [{pageSlug: 'game-one'}],
  }]}}}})});
  await f.run('.epic');
  assert.match(f.edits.at(-1).text, /Game &lt;One&gt;/);
  assert.match(f.edits.at(-1).text, /Fun &amp; free/);
  assert.match(f.edits.at(-1).text, /前往领取/);
  assert.equal(f.edits.at(-1).options.linkPreview, false);
});

test('epic rejects malformed API data with a stable user-facing error', async t => {
  const f = await fixture(t, 'epic', {fetch: async () => Response.json({secret: 'do-not-leak'})});
  await f.run('.epic');
  assert.match(f.edits.at(-1).text, /获取限免失败/);
  assert.doesNotMatch(JSON.stringify(f.edits), /do-not-leak/);
});
