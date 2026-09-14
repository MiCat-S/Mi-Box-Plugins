'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const {returnBigInt, resolveId} = {
  ...require(path.join(core, 'node_modules/teleproto/Helpers.js')),
  ...require(path.join(core, 'node_modules/teleproto/Utils.js')),
};

function createPlugin() {
  const {artifactDir} = buildPlugin({id: 'bs', packageRoot: path.resolve(__dirname, '../bs'), entry: 'v2.ts'});
  const entry = path.join(artifactDir, 'index.cjs');
  delete require.cache[require.resolve(entry)];
  return require(entry).default();
}

async function floodFixture(t, invoke, config = {}, hooks = {}) {
  const storageRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-bs-flood-')));
  await fs.mkdir(path.join(storageRoot, 'bs'));
  await fs.writeFile(path.join(storageRoot, 'bs', 'config.json'), JSON.stringify({schemaVersion: 1, seq: '1', mode: 'sequence',
    targets: [{id: '1', target: '@target', createdAt: '1'}], ...config}));
  const edits = [];
  const client = {async getMessages(peer, {ids}) {
      return hooks.getMessages ? hooks.getMessages(peer, ids[0]) : [{id: ids[0]}];}, async getEntity(value) {
    return hooks.getEntity ? hooks.getEntity(value) : {id: returnBigInt(9), title: String(value)};},
    async getInputEntity(value) {return value;}, invoke, async sendMessage(...args) {return hooks.sendMessage?.(...args);}};
  const host = new PluginHost({storageRoot, logger: {info() {}, error() {}}, telegram: {
    async edit(_message, text) {edits.push(text);}, async reply() {}, async invoke() {},
    async getReply() {return {id: 41, raw: {id: 41}};}, async withClient(operation, signal) {return operation(client, signal);},
  }});
  await host.load(createPlugin());
  t.after(async () => {await host.shutdown(2000); await fs.rm(storageRoot, {recursive: true, force: true});});
  return {host, edits, run: () => host.dispatchPrimary({id: 42, chatId: '-1009', senderId: '7', outgoing: true, replyToId: 41,
    text: '.bs', raw: {peerId: returnBigInt('-1009')}})};
}

test('bs uses exact Teleproto peers and posts linked feedback in the target topic', async t => {
  const storageRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-bs-compat-')));
  await fs.mkdir(path.join(storageRoot, 'bs'));
  await fs.writeFile(path.join(storageRoot, 'bs', 'config.json'), JSON.stringify({
    schemaVersion: 1,
    seq: '1',
    mode: 'sequence',
    targets: [{id: '1', target: '@target', chatId: '9007199254740995', topicId: '88', display: 'Target', createdAt: '1'}],
  }));
  const sourceMarked = '-1009007199254740993';
  const sourceEntity = new Api.Channel({id: returnBigInt('9007199254740993'), accessHash: returnBigInt(2), title: 'Source'});
  const targetEntity = new Api.Channel({id: returnBigInt('9007199254740995'), accessHash: returnBigInt(3), title: 'Target'});
  const forwarded = new Api.Message({id: 501, peerId: new Api.PeerChannel({channelId: targetEntity.id}), message: 'forwarded'});
  const sends = [];
  let fetchedPeer;
  let lookedUp;
  const client = {
    async getMessages(peer, {ids}) { fetchedPeer = peer; return [{id: ids[0]}]; },
    async getEntity(value) {
      if (value === sourceEntity || value?.toString() === sourceMarked) return sourceEntity;
      lookedUp = value;
      return targetEntity;
    },
    async getInputEntity() { return new Api.InputPeerChannel({channelId: targetEntity.id, accessHash: targetEntity.accessHash}); },
    async invoke() { return {updates: [{message: forwarded}]}; },
    async sendMessage(peer, options) { sends.push({peer, options}); },
  };
  const edits = [];
  const host = new PluginHost({
    storageRoot,
    logger: {info() {}, error() {}},
    telegram: {
      async edit(_message, text, options) { edits.push({text, options}); },
      async reply() {}, async invoke() {},
      async getReply() { return {id: 41, chatId: sourceMarked, raw: {id: 41}}; },
      async withClient(operation, signal) { return operation(client, signal); },
    },
  });
  await host.load(createPlugin());
  t.after(async () => { await host.shutdown(2000); await fs.rm(storageRoot, {recursive: true, force: true}); });

  await host.dispatchPrimary({id: 42, chatId: sourceMarked, senderId: '7', outgoing: true, replyToId: 41, text: '.bs', raw: {}});

  assert.equal(fetchedPeer.toString(), sourceMarked);
  assert.equal(resolveId(fetchedPeer)[1], Api.PeerChannel);
  assert.equal(lookedUp.toString(), '9007199254740995');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].peer, targetEntity);
  assert.equal(sends[0].options.replyTo, 501);
  assert.equal(sends[0].options.topMsgId, 88);
  assert.match(sends[0].options.message, /来源：.*Source/);
  assert.match(sends[0].options.message, /https:\/\/t\.me\/c\/9007199254740993\/41/);
  assert.match(sends[0].options.message, /https:\/\/t\.me\/c\/9007199254740995\/501/);
  assert.match(edits.at(-1).text, /已被保送到频道/);
});

test('bs cancellation during target resolution prevents later native side effects', async t => {
  const storageRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-bs-cancel-')));
  await fs.mkdir(path.join(storageRoot, 'bs'));
  await fs.writeFile(path.join(storageRoot, 'bs', 'config.json'), JSON.stringify({
    schemaVersion: 1, seq: '1', mode: 'sequence',
    targets: [{id: '1', target: '@target', createdAt: '1'}],
  }));
  let resolving;
  let releaseResolution;
  const started = new Promise(resolve => { resolving = resolve; });
  const release = new Promise(resolve => { releaseResolution = resolve; });
  let inputLookups = 0;
  let invokes = 0;
  let sends = 0;
  const client = {
    async getMessages(_peer, {ids}) { return [{id: ids[0]}]; },
    async getEntity() { resolving(); await release; return {id: returnBigInt(9), title: 'Target'}; },
    async getInputEntity() { inputLookups += 1; },
    async invoke() { invokes += 1; },
    async sendMessage() { sends += 1; },
  };
  const edits = [];
  const host = new PluginHost({
    storageRoot,
    logger: {info() {}, error() {}},
    telegram: {
      async edit(_message, text) { edits.push(text); }, async reply() {}, async invoke() {},
      async getReply() { return {id: 41, raw: {id: 41}}; },
      async withClient(operation, signal) { return operation(client, signal); },
    },
  });
  await host.load(createPlugin());
  t.after(async () => { await host.shutdown(2000); await fs.rm(storageRoot, {recursive: true, force: true}); });
  const dispatch = host.dispatchPrimary({id: 42, chatId: '-1009', senderId: '7', outgoing: true, replyToId: 41, text: '.bs', raw: {}});
  await started;
  const unloading = host.unload('bs', 2000);
  releaseResolution();
  assert.equal((await unloading).completed, true);
  await dispatch;
  assert.equal(inputLookups, 0);
  assert.equal(invokes, 0);
  assert.equal(sends, 0);
  assert.doesNotMatch(edits.join('\n'), /保送失败/);
});

test('bs waits once for FLOOD_WAIT and then retries successfully', async t => {
  let calls = 0;
  const fixture = await floodFixture(t, async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('private detail'), {errorMessage: 'FLOOD_WAIT_0'});
    return {updates: []};
  });
  await fixture.run();
  assert.equal(calls, 2);
  assert.match(fixture.edits.at(-1), /已被保送到频道/);
  assert.doesNotMatch(fixture.edits.join('\n'), /private detail|FLOOD_WAIT/);
});

test('bs unload during FLOOD_WAIT aborts the wait without another request', async t => {
  let calls = 0;
  let firstCall;
  const started = new Promise(resolve => {firstCall = resolve;});
  const fixture = await floodFixture(t, async () => {
    calls += 1; firstCall();
    throw Object.assign(new Error('private detail'), {errorMessage: 'FLOOD_WAIT_30'});
  });
  const dispatch = fixture.run();
  await started;
  assert.equal((await fixture.host.unload('bs', 2000)).completed, true);
  await dispatch;
  assert.equal(calls, 1);
  assert.doesNotMatch(fixture.edits.join('\n'), /保送失败|private detail|FLOOD_WAIT/);
});

test('bs rejects FLOOD_WAIT beyond its retry budget with fixed feedback', async t => {
  let calls = 0;
  const fixture = await floodFixture(t, async () => {
    calls += 1;
    throw Object.assign(new Error('private detail'), {errorMessage: 'FLOOD_WAIT_60'});
  });
  await fixture.run();
  assert.equal(calls, 1);
  assert.match(fixture.edits.at(-1), /^操作频繁，请稍后重试/);
  assert.doesNotMatch(fixture.edits.join('\n'), /private detail|FLOOD_WAIT/);
});

test('bs broadcast keeps surrounding successes when the middle target is throttled', async t => {
  const calls = [];
  const fixture = await floodFixture(t, async request => {
    const target = request.toPeer.title;
    calls.push(target);
    if (target === '@two') throw Object.assign(new Error('private detail'), {errorMessage: 'FLOOD_WAIT_60'});
    return {updates: []};
  }, {seq: '3', mode: 'broadcast', targets: [
    {id: '1', target: '@one', createdAt: '1'},
    {id: '2', target: '@two', createdAt: '2'},
    {id: '3', target: '@three', createdAt: '3'},
  ]});
  await fixture.run();
  assert.deepEqual(calls, ['@one', '@two', '@three']);
  assert.match(fixture.edits.at(-1), /亲爱的被观察者[\s\S]*@one[\s\S]*@three/);
  assert.match(fixture.edits.at(-1), /限流：@two/);
  assert.doesNotMatch(fixture.edits.join('\n'), /private detail|FLOOD_WAIT/);
});

test('bs cancellation while forwarding prevents source resolution and feedback', async t => {
  let forwardStarted;
  let releaseForward;
  const started = new Promise(resolve => {forwardStarted = resolve;});
  const release = new Promise(resolve => {releaseForward = resolve;});
  let entityCalls = 0;
  let feedback = 0;
  const fixture = await floodFixture(t, async () => {
    forwardStarted();
    await release;
    return {updates: [{message: {className: 'Message', id: 501}}]};
  }, {}, {
    getEntity(value) {entityCalls += 1; return {id: returnBigInt(9), title: String(value)};},
    sendMessage() {feedback += 1;},
  });
  const dispatch = fixture.run();
  await started;
  const unloading = fixture.host.unload('bs', 2000);
  releaseForward();
  assert.equal((await unloading).completed, true);
  await dispatch;
  assert.equal(entityCalls, 1);
  assert.equal(feedback, 0);
  assert.doesNotMatch(fixture.edits.join('\n'), /保送失败/);
});

test('bs reports forwards-restricted sources with the original fixed message', async t => {
  let calls = 0;
  const fixture = await floodFixture(t, async () => {
    calls += 1;
    throw Object.assign(new Error('private detail'), {errorMessage: 'CHAT_FORWARDS_RESTRICTED'});
  });
  await fixture.run();
  assert.equal(calls, 1);
  assert.match(fixture.edits.at(-1), /^该消息不允许被转发$/);
  assert.doesNotMatch(fixture.edits.join('\n'), /private detail|CHAT_FORWARDS_RESTRICTED|保送失败/);
});

test('bs skips deleted messages while collecting and still forwards', async t => {
  const scanned = [];
  let requested;
  const fixture = await floodFixture(t, async request => {
    requested = request.id;
    return {updates: []};
  }, {}, {
    getMessages(_peer, id) {
      scanned.push(id);
      if (id === 42 || id === 44) throw new Error('MESSAGE_ID_INVALID');
      return [{id}];
    },
  });
  const items = [
    {id: 42, chatId: '-1009', senderId: '7', outgoing: true, replyToId: 41, text: '.bs 3', raw: {peerId: returnBigInt('-1009')}},
  ];
  await fixture.host.dispatchPrimary(items[0]);
  assert.deepEqual(scanned, [41, 42, 43, 44, 45]);
  assert.deepEqual(requested, [41, 43, 45]);
  assert.match(fixture.edits.at(-1), /已被保送到频道/);
  assert.match(fixture.edits.at(-1), /3 条消息/);
  assert.doesNotMatch(fixture.edits.join('\n'), /保送失败|MESSAGE_ID_INVALID/);
});

test('bs bounds its source scan by the search limit', async t => {
  let scanned = 0;
  const fixture = await floodFixture(t, async () => ({updates: []}), {}, {
    getMessages() {scanned += 1; throw new Error('MESSAGE_ID_INVALID');},
  });
  await fixture.host.dispatchPrimary({id: 42, chatId: '-1009', senderId: '7', outgoing: true, replyToId: 41,
    text: '.bs 100000', raw: {peerId: returnBigInt('-1009')}});
  assert.equal(scanned, 500);
  assert.match(fixture.edits.at(-1), /未找到可转发的消息/);
});

test('bs escapes hostile target titles in list output', async t => {
  const fixture = await floodFixture(t, async () => ({updates: []}), {
    targets: [{id: '1', target: '@evil', display: '<b>x</b>&amp;<script>', createdAt: '1'}],
  });
  await fixture.host.dispatchPrimary({id: 42, chatId: '-1009', senderId: '7', outgoing: true, text: '.bs list', raw: {peerId: returnBigInt('-1009')}});
  const text = fixture.edits.at(-1);
  assert.doesNotMatch(text, /<script>|<b>x<\/b>/);
  // 旧版把转义后的 HTML 存进 display，展示时应还原成纯文本再转义一次，而不是二次转义
  assert.match(text, /x&amp;$/);
  assert.doesNotMatch(text, /&amp;amp;/);
  assert.doesNotMatch(text, /&lt;script&gt;/);
});

test('bs reports per-target RPC failures with the code but not the raw error', async t => {
  const fixture = await floodFixture(t, async () => ({updates: []}), {}, {
    getEntity() {throw Object.assign(new Error('private detail'), {errorMessage: 'CHAT_WRITE_FORBIDDEN'});},
  });
  await fixture.run();
  const text = fixture.edits.at(-1);
  assert.match(text, /保送失败/);
  assert.match(text, /CHAT_WRITE_FORBIDDEN/);
  assert.doesNotMatch(text, /private detail/);
});

test('bs reports the collected count when the target name is unavailable', async t => {
  const fixture = await floodFixture(t, async () => ({updates: []}), {}, {
    getEntity(value) {return {id: returnBigInt(9)};},
  });
  await fixture.host.dispatchPrimary({id: 42, chatId: '-1009', senderId: '7', outgoing: true, replyToId: 41,
    text: '.bs 3', raw: {peerId: returnBigInt('-1009')}});
  const text = fixture.edits.at(-1);
  assert.match(text, /3 条消息已被保送到频道/);
  assert.doesNotMatch(text, /来源对话/);
});
