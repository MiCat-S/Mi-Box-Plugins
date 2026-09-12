'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {setImmediate: nextTurn} = require('node:timers/promises');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'parsehub', packageRoot: path.resolve(__dirname, '../parsehub'), entry: 'v2.ts'});
const built = require(path.join(artifactDir, 'index.cjs'));
const create = built.default;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function memory(initial) {
  let value = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    read: () => tail.then(() => structuredClone(value)),
    update(operation) {
      const next = tail.then(async () => {
        value = await operation(structuredClone(value));
        return structuredClone(value);
      });
      tail = next.then(() => undefined, () => undefined);
      return next;
    },
    value: () => structuredClone(value),
  };
}

const invocation = (url, chatId = '-1009007199254740993', topicId) => ({
  command: 'parsehub', prefix: '.', args: [url],
  message: {id: 1, chatId, senderId: '9007199254740995', outgoing: true, text: `.parsehub ${url}`,
    ...(topicId === undefined ? {} : {topicId})},
});

test('parsehub extracts bounded safe links and distinguishes progress from final media', () => {
  assert.deepEqual(built.extractLinks('x www.example.com/a). https://u:p@example.com/no https://example.com/a。'),
    ['https://www.example.com/a', 'https://example.com/a']);
  assert.equal(built.extractLinks(Array.from({length: 12}, (_, index) => `https://e.test/${index}`).join(' ')).length, 10);
  assert.equal(built.isProgressText(' ▓ 解 析 中 50%'), true);
  assert.equal(built.isFinalBotMessage({message: '解 析 中 50%'}), false);
  assert.equal(built.isFinalBotMessage({message: '', media: {className: 'MessageMediaDocument'}}), true);
});

test('parsehub relays only post-boundary bot results and does not let repeated history postpone completion', async t => {
  t.mock.timers.enable({apis: ['Date', 'setTimeout']});
  const state = memory({schemaVersion: 1, initialized: false, ignoredUpToId: 0, future: 'kept'});
  const history = [{id: 10, out: false, className: 'Message', message: 'welcome'}];
  const sent = [], forwarded = [], edits = [];
  const signal = new AbortController().signal;
  const client = {
    async getMessages(_bot, options) {assert.equal(options.limit, 50); return history.slice();},
    async getEntity() {return {id: 7n, accessHash: 8n};},
    async getInputEntity(value) {return value;},
    async invoke() {},
    async sendMessage(_bot, options) {
      sent.push(options.message);
      assert.notEqual(options.message, '/start');
      history.unshift(
        {id: 12, out: false, className: 'Message', message: 'done'},
        {id: 11, out: false, className: 'Message', message: '解 析 中 50%'},
      );
      return {id: 11};
    },
    async forwardMessages(peer, options) {forwarded.push({peer, options});},
  };
  const context = {
    signal,
    storage: {json: () => state},
    telegram: {
      edit: async (_message, text) => edits.push(text), reply: async () => assert.fail('unexpected relay failure'),
      getReply: async () => undefined, withClient: operation => operation(client, signal),
    },
    log: {error() {}},
  };
  const plugin = create();
  await plugin.setup(context);
  const running = plugin.commands.parsehub.handle(invocation('https://example.com/post', '-1009007199254740993', 77), context);
  try {
    for (let index = 0; index < 4; index += 1) {
      await nextTurn();
      t.mock.timers.tick(2_000);
    }
    await running;
  } finally {
    t.mock.timers.reset();
  }
  assert.deepEqual(sent, ['https://example.com/post']);
  assert.deepEqual(forwarded, [{peer: '-1009007199254740993', options: {fromPeer: '@ParseHubot', messages: [12], dropAuthor: true, replyTo: 1, topMsgId: 77}}]);
  assert.equal(state.value().ignoredUpToId, 12);
  assert.equal(state.value().future, 'kept');
  assert.match(edits.at(-1), /1\/1/);
});

test('parsehub does not mark the bot ready or send a business link when welcome times out', async t => {
  t.mock.timers.enable({apis: ['Date', 'setTimeout']});
  const state = memory({schemaVersion: 1, initialized: true, ignoredUpToId: 0});
  const sent = [], edits = [];
  const signal = new AbortController().signal;
  const client = {async getMessages() {return [];}, async getEntity() {throw new Error('not found');},
    async getInputEntity(value) {return value;}, async invoke() {}, async sendMessage(_bot, options) {sent.push(options.message); return {id: 5};}};
  const context = {signal, storage: {json: () => state}, telegram: {edit: async (_message, text) => edits.push(text),
    reply: async () => {}, getReply: async () => undefined, withClient: operation => operation(client, signal)}, log: {error() {}}};
  const running = create().commands.parsehub.handle(invocation('https://example.com/business'), context);
  try {for(let index=0;index<22;index+=1){await nextTurn();t.mock.timers.tick(500);}await running;}
  finally {t.mock.timers.reset();}
  assert.deepEqual(sent, ['/start']);
  assert.match(edits.at(-1), /解析失败/);
  assert.equal(state.value().ignoredUpToId, 5);
});

test('parsehub serializes chats and cancellation releases its instance queue', async () => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const controller = new AbortController();
  const state = memory({schemaVersion: 1, initialized: true, ignoredUpToId: 10});
  const sent = [];
  const client = {
    async getMessages() {return [{id: 10, out: false, className: 'Message', message: 'welcome'}];},
    async getEntity() {return {id: 7n, accessHash: 8n};}, async getInputEntity(value) {return value;}, async invoke() {},
    async sendMessage(_bot, options) {
      sent.push(options.message);
      if (options.message.includes('/first')) {firstEntered.resolve(); await releaseFirst.promise;}
      return {id: 11};
    },
  };
  const context = {
    signal: controller.signal, storage: {json: () => state},
    telegram: {edit: async () => {}, reply: async () => {}, getReply: async () => undefined,
      withClient: operation => operation(client, controller.signal)},
    log: {error() {}},
  };
  const plugin = create();
  const first = plugin.commands.parsehub.handle(invocation('https://example.com/first', '-1001'), context);
  await firstEntered.promise;
  const second = plugin.commands.parsehub.handle(invocation('https://example.com/second', '-1002'), context);
  await nextTurn();
  assert.deepEqual(sent, ['https://example.com/first']);
  controller.abort();
  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(sent, ['https://example.com/first']);
  plugin.cleanup(context);
});

test('parsehub real host unload aborts a pending poll and preserves the full bot-history boundary', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'parsehub-part-3-')));
  const linkSent = deferred();
  const history = [
    {id: 99, out: true, className: 'Message', message: 'manual request'},
    {id: 10, out: false, className: 'Message', message: 'welcome'},
  ];
  const client = {
    async getMessages(_bot, options) {assert.equal(options.limit, 50); return history.slice();},
    async getEntity() {return {id: 7n, accessHash: 8n};}, async getInputEntity(value) {return value;}, async invoke() {},
    async sendMessage(_bot, options) {linkSent.resolve(options.message); return {id: 100};},
  };
  const host = new PluginHost({
    storageRoot: root, concurrency: 4, logger: {info() {}, error() {}},
    telegram: {edit: async () => {}, reply: async () => {}, invoke: async () => {}, getReply: async () => undefined,
      withClient: (operation, signal) => operation(client, signal)},
  });
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  await host.load(create());
  const saved = JSON.parse(await fs.readFile(path.join(root, 'parsehub', 'state.json'), 'utf8'));
  assert.equal(saved.ignoredUpToId, 99);
  const running = host.dispatchPrimary({id: 1, chatId: '-1009007199254740993', senderId: '9007199254740995',
    outgoing: true, text: '.parsehub https://example.com/pending'});
  assert.equal(await linkSent.promise, 'https://example.com/pending');
  const report = await host.unload('parsehub', 1000);
  assert.equal(report.completed, true);
  await running;
});
