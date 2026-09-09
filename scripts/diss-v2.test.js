'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {definePlugin} = require(path.join(core, 'dist/v2/sdk.js'));
const {artifactDir} = buildPlugin({id: 'diss', packageRoot: path.resolve(__dirname, '../diss'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

const ME = {id: 999, username: 'mibot'};
const TARGET = 42;

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

async function fixture(t, {ai, selection, fetch, entities = new Map([['@victim', {id: TARGET}]]), reply} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-diss-v2-')));
  const edits = [];
  const replies = [];
  const client = {
    async getMe() { return ME; },
    async getEntity(target) {
      if (entities.has(target)) return entities.get(target);
      throw new Error('entity unavailable');
    },
  };
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, ...(fetch ? {http: {fetch}} : {}), telegram: {
    async edit(message, text, options) { edits.push({message, text, options}); },
    async reply(message, text, options) { replies.push({message, text, options}); },
    async invoke() {},
    async getReply() { return reply; },
    async withClient(operation, signal) { return operation(client, signal); },
  }});
  if (ai || selection) await host.load(definePlugin({apiVersion: 1, id: 'ai', description: 'fixture', commands: {}, services: {
    ...(ai ? {chat: {description: 'fixture', handle(input, _ctx, signal) { signal.throwIfAborted(); return ai(input, signal); }}} : {}),
    ...(selection ? {selection: {description: 'fixture', handle() { return selection; }}} : {}),
  }}));
  await host.load(create());
  t.after(async () => { await host.shutdown(2000); await fs.rm(root, {recursive: true, force: true}); });
  return {host, edits, replies, root,
    run: (text, extra = {}) => host.dispatchPrimary({id: 1, chatId: '1', senderId: String(ME.id), outgoing: true, text, ...extra}),
    listen: (extra = {}) => host.dispatchListeners({id: 2, chatId: '1', senderId: String(TARGET), outgoing: false, text: 'hello', ...extra}),
  };
}

test('diss help renders the full guide without network access', async t => {
  const f = await fixture(t, {fetch: () => assert.fail('unexpected HTTP')});
  await f.run('.diss help');
  assert.match(f.edits.at(-1).text, /嘴臭对线机/);
  assert.match(f.edits.at(-1).text, /undiss/);
  assert.equal(f.edits.at(-1).options.parseMode, 'html');
});

test('diss locks a replied target and rejects locking yourself', async t => {
  const f = await fixture(t, {reply: {id: 2, chatId: '1', senderId: String(TARGET), text: 'hi', raw: {sender: {firstName: 'Victim', lastName: 'One'}}}});
  await f.run('.diss');
  assert.match(f.edits.at(-1).text, /已锁定 <b>Victim One<\/b>/);
  assert.match(f.edits.at(-1).text, new RegExp(`<code>${TARGET}</code>`));

  const self = await fixture(t, {reply: {id: 3, chatId: '1', senderId: String(ME.id), text: 'me'}});
  await self.run('.diss');
  assert.match(self.edits.at(-1).text, /不能锁自己/);
});

test('diss resolves mentions, numeric ids and escaped names', async t => {
  const f = await fixture(t, {reply: {id: 2, chatId: '1', senderId: String(TARGET), text: 'hi', raw: {sender: {firstName: '<b>Bad</b>'}}}});
  await f.run('.diss', {raw: {className: 'Message', message: '.diss @victim', entities: [{className: 'MessageEntityMention', offset: 6, length: 7}]}});
  assert.match(f.edits.at(-1).text, /已锁定 <b>@victim<\/b>/);

  await f.run('.diss', {raw: {className: 'Message', message: '.diss 123456789'}});
  assert.match(f.edits.at(-1).text, /<code>123456789<\/code>/);

  await f.run('.diss', {raw: {className: 'Message', message: '.diss @victim', entities: [{className: 'MessageEntityMentionName', offset: 6, length: 7, userId: TARGET}]}});
  assert.match(f.edits.at(-1).text, /已锁定 <b>victim<\/b>/);

  await f.run('.diss');
  assert.match(f.edits.at(-1).text, /&lt;b&gt;Bad&lt;\/b&gt;/);
});

test('undiss, dislist and dissclear manage the per-chat state', async t => {
  const f = await fixture(t, {reply: {id: 2, chatId: '1', senderId: String(TARGET), text: 'hi', raw: {sender: {firstName: 'Victim'}}}});
  await f.run('.diss');
  await f.run('.dislist');
  assert.match(f.edits.at(-1).text, /本会话已锁定 1 人/);
  await f.run('.undiss');
  assert.match(f.edits.at(-1).text, /已解锁 <b>Victim<\/b>/);
  await f.run('.dislist');
  assert.match(f.edits.at(-1).text, /暂无锁定目标/);
  await f.run('.diss');
  await f.run('.dissclear');
  assert.match(f.edits.at(-1).text, /锁定已全部清除/);
});

test('a locked target gets an AI reply that is escaped and counted', async t => {
  let calls = 0;
  const f = await fixture(t, {
    reply: {id: 2, chatId: '1', senderId: String(TARGET), text: 'hi', raw: {sender: {firstName: 'Victim'}}},
    ai: input => { calls++; assert.match(input.text, /Victim/); assert.match(input.systemPrompt, /对喷游戏/); return '<b>你个憨批</b>'; },
  });
  await f.run('.diss');
  await f.listen();
  await waitFor(() => f.replies.length === 1);
  assert.equal(calls, 1);
  assert.equal(f.replies[0].text, '&lt;b&gt;你个憨批&lt;/b&gt;');
  assert.equal(f.replies[0].options.parseMode, 'html');
  await new Promise(resolve => setTimeout(resolve, 150));
  await f.run('.dislist');
  assert.match(f.edits.at(-1).text, /已喷 1 次/);
});

test('cooldown suppresses rapid repeats and outgoing messages are never auto-replied', async t => {
  const f = await fixture(t, {ai: () => '你个憨批', reply: {id: 2, chatId: '1', senderId: String(TARGET), text: 'hi', raw: {sender: {firstName: 'Victim'}}}});
  await f.run('.diss');
  await Promise.all([f.listen(), f.listen(), f.listen()]);
  await waitFor(() => f.replies.length === 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.replies.length, 1);
  await f.listen({senderId: String(ME.id), outgoing: true, text: 'self'});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.replies.length, 1);
});

test('AI is unavailable, rejects reasoning output, or fails: local template is used', async t => {
  const fallback = await fixture(t, {reply: {id: 2, chatId: '1', senderId: String(TARGET), text: 'hi', raw: {sender: {firstName: 'Victim'}}}});
  await fallback.run('.diss');
  await fallback.listen();
  await waitFor(() => fallback.replies.length === 1);
  assert.match(fallback.replies[0].text, /Victim/);

  const reasoning = await fixture(t, {ai: () => '方案一：先分析一下。思路是这样。总结完毕。', reply: {id: 2, chatId: '1', senderId: String(TARGET), text: 'hi', raw: {sender: {firstName: 'Victim'}}}});
  await reasoning.run('.diss');
  await reasoning.listen();
  await waitFor(() => reasoning.replies.length === 1);
  assert.doesNotMatch(reasoning.replies[0].text, /方案一/);
  assert.match(reasoning.replies[0].text, /Victim/);

  const failing = await fixture(t, {ai: () => { throw new Error('provider detail'); }, reply: {id: 2, chatId: '1', senderId: String(TARGET), text: 'hi', raw: {sender: {firstName: 'Victim'}}}});
  await failing.run('.diss');
  await failing.listen();
  await waitFor(() => failing.replies.length === 1);
  assert.match(failing.replies[0].text, /Victim/);
  assert.doesNotMatch(failing.replies[0].text, /provider detail/);
});

test('diss 语录 keeps the legacy quote behavior', async t => {
  const f = await fixture(t, {fetch: async () => new Response('  usable quote  ', {status: 200})});
  await f.run('.diss 语录');
  assert.equal(f.edits.at(-1).text, 'usable quote');
  assert.equal(f.edits.at(-1).options.parseMode, 'html');
});

test('dissai overrides the provider, model and reasoning effort used for replies', async t => {
  const seen = [];
  const f = await fixture(t, {
    reply: {id: 2, chatId: '1', senderId: String(TARGET), text: 'hi', raw: {sender: {firstName: 'Victim'}}},
    ai: input => { seen.push(input); return '你个憨批'; },
    selection: {chat: {tag: 'main', model: 'model-main', reasoningEffort: 'high', serviceTier: 'auto'}},
  });
  await f.run('.dissai');
  assert.match(f.edits.at(-1).text, /跟随 ai 插件（当前 main \/ model-main · 思考 high）/);
  assert.match(f.edits.at(-1).text, /auto \| none \| minimal \| low \| medium \| high \| xhigh/);
  await f.run('.dissai help');
  assert.match(f.edits.at(-1).text, /Diss AI 设置/);
  await f.run('.dissai model diss-model');
  assert.match(f.edits.at(-1).text, /已设置 Diss 模型：<code>diss-model<\/code>/);
  await f.run('.dissai provider alt');
  assert.match(f.edits.at(-1).text, /已设置 Diss 提供商：<code>alt<\/code>/);
  await f.run('.dissai reasoning none');
  assert.match(f.edits.at(-1).text, /已设置 Diss 思考强度：<code>none<\/code>/);
  await f.run('.dissai');
  assert.match(f.edits.at(-1).text, /diss-model/);
  assert.match(f.edits.at(-1).text, /alt/);
  assert.match(f.edits.at(-1).text, /none/);
  await f.run('.diss');
  await f.listen();
  await waitFor(() => f.replies.length === 1);
  assert.equal(seen[0].model, 'diss-model');
  assert.equal(seen[0].tag, 'alt');
  assert.equal(seen[0].reasoningEffort, 'none');
  await f.run('.dissai reasoning bogus');
  assert.match(f.edits.at(-1).text, /思考强度必须是/);
  await f.run('.dissai model reset');
  assert.match(f.edits.at(-1).text, /已恢复跟随 ai 插件的模型/);
});

test('a locked target gets a reply for media-only messages but not service or empty ones', async t => {
  const seen = [];
  const f = await fixture(t, {
    reply: {id: 2, chatId: '1', senderId: String(TARGET), text: 'hi', raw: {sender: {firstName: 'Victim'}}},
    ai: input => { seen.push(input); return '你个憨批'; },
  });
  await f.run('.diss');
  await f.listen({text: '', raw: {action: {className: 'MessageActionPinMessage'}}});
  await f.listen({text: '', raw: {}});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.replies.length, 0);
  await f.listen({text: '', raw: {sticker: {alt: '😂'}}});
  await waitFor(() => f.replies.length === 1);
  assert.match(seen[0].text, /发了一个表情包（😂）/);
  assert.equal(f.replies.length, 1);
});

test('nickname timezone suffixes are stripped when locking', async t => {
  const seen = [];
  const f = await fixture(t, {
    reply: {id: 2, chatId: '1', senderId: String(TARGET), text: 'hi', raw: {sender: {firstName: '江砚 𝟚𝟙:𝟜𝟙 𝔾𝕄𝕋+𝟠'}}},
    ai: input => { seen.push(input); return '你个憨批'; },
  });
  await f.run('.diss');
  assert.match(f.edits.at(-1).text, /已锁定 <b>江砚<\/b>/);
  assert.doesNotMatch(f.edits.at(-1).text, /𝔾𝕄𝕋/);
  await f.listen();
  await waitFor(() => f.replies.length === 1);
  assert.match(seen[0].text, /对方昵称：江砚/);
  assert.doesNotMatch(seen[0].text, /𝔾𝕄𝕋/);
});

test('nickname timezone suffixes are stripped from previously stored names too', async t => {
  const seen = [];
  const f = await fixture(t, {ai: input => { seen.push(input); return '你个憨批'; }});
  await fs.mkdir(path.join(f.root, 'diss'), {recursive: true});
  await fs.writeFile(path.join(f.root, 'diss', 'state.json'),
    JSON.stringify({'1': {42: {name: '江砚 𝟚𝟙:𝟜𝟙 𝔾𝕄𝕋+𝟠', lockedAt: 0, hits: 0}}}));
  await f.listen();
  await waitFor(() => f.replies.length === 1);
  assert.match(seen[0].text, /对方昵称：江砚/);
  assert.doesNotMatch(seen[0].text, /𝔾𝕄𝕋/);
});
