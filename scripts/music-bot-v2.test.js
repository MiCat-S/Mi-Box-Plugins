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
const {ResourceScope} = require(path.join(core, 'dist/v2/lifecycle.js'));
const {artifactDir} = buildPlugin({id: 'music_bot', packageRoot: path.resolve(__dirname, '../music_bot'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function responsiveClient(options = {}) {
  const histories = new Map(), nextIds = new Map();
  const sent = [], files = [], clicks = [], events = [];
  const history = bot => {
    if (!histories.has(bot)) histories.set(bot, []);
    return histories.get(bot);
  };
  const nextId = bot => {
    const value = (nextIds.get(bot) ?? 100) + 1;
    nextIds.set(bot, value);
    return value;
  };
  const client = {
    async invoke() {},
    async getInputEntity(value) { return value; },
    async getMessages(bot) { return history(bot).slice(); },
    async sendMessage(bot, value) {
      sent.push({bot, message: value.message});
      events.push(`send:${value.message}`);
      await options.beforeSend?.(bot, value.message);
      const outgoing = {id: nextId(bot), out: true, date: 1_900_000_000};
      history(bot).unshift(outgoing);
      if (value.message !== '/start' && value.message !== '1') {
        const request = value.message;
        const choice = {
          id: nextId(bot), out: false, date: 1_900_000_000, buttonCount: 1,
          async click(selection) {
            clicks.push({bot, request, selection});
            events.push(`click:${request}`);
            await options.beforeClick?.(bot, request);
            history(bot).unshift({id: nextId(bot), out: false, date: 1_900_000_000,
              media: {request, bot}});
          },
        };
        history(bot).unshift(choice);
      }
      return outgoing;
    },
    async sendFile(peer, value) {
      files.push({peer, value});
      events.push(`file:${value.file.request}`);
      await options.onFile?.(peer, value);
    },
  };
  return {client, sent, files, clicks, events, histories};
}

async function hostFixture(t, client, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-music-bot-')));
  const edits = [], errors = [], operationSignals = options.operationSignals ?? [];
  let nativeCalls = 0, messageId = 0;
  const host = new PluginHost({
    storageRoot: root,
    concurrency: 8,
    logger: {info() {}, error(event) { errors.push(event); }},
    telegram: {
      async edit(message, text, editOptions) { edits.push({message, text, options: editOptions}); },
      async reply() { assert.fail('unexpected reply'); },
      async invoke() { assert.fail('unexpected transport invoke'); },
      async getReply() { assert.fail('unexpected reply read'); },
      async withClient(operation, hostSignal) {
        const index = nativeCalls++;
        options.onNative?.(index);
        const explicit = operationSignals[index]?.signal;
        const signal = explicit ? AbortSignal.any([hostSignal, explicit]) : hostSignal;
        return operation(client, signal);
      },
    },
  });
  await host.load(create());
  t.after(async () => {
    const report = await host.shutdown(2000);
    assert.equal(report.completed, true, 'real PluginHost and ResourceScope must drain');
    await fs.rm(root, {recursive: true, force: true});
  });
  return {
    host, edits, errors,
    run(text, raw = {}) {
      const id = ++messageId;
      return host.dispatchPrimary({id, chatId: String(10_000 + id), senderId: '42', outgoing: true, text,
        raw: {peerId: id, async delete() {}, ...raw}});
    },
  };
}

test('music_bot preserves every command, source mapping, button selection, and ym caption behavior', async t => {
  const f = responsiveClient();
  const runtime = await hostFixture(t, f.client);
  assert.deepEqual(Object.keys(create().commands).sort(),
    ['mbkg', 'mbkw', 'mbne', 'mbqq', 'mbs', 'mbvk', 'mbym', 'music_bot']);

  const cases = [
    ['.music_bot search nested', '@music_v1bot', '/search nested', '🎵 nested'],
    ['.mbs search', '@music_v1bot', '/search search', '🎵 search'],
    ['.mbkw kuwo', '@music_v1bot', '/kuwo kuwo', '🎵 kuwo'],
    ['.mbkg kugou', '@music_v1bot', '/kugou kugou', '🎵 kugou'],
    ['.mbqq qq', '@music_v1bot', '/qq qq', '🎵 qq'],
    ['.mbne netease', '@music_v1bot', '/netease netease', '🎵 netease'],
    ['.mbvk vk', '@vkmusic_bot', 'vk', '🎵 vk'],
    ['.mbym youtube', '@ttaudiobot', 'youtube', undefined],
  ];
  for (const [command, bot, request, caption] of cases) {
    assert.equal(await runtime.run(command), true);
    assert.deepEqual(f.sent.findLast(value => value.message !== '/start'), {bot, message: request});
    assert.deepEqual(f.clicks.at(-1).selection, {i: 0});
    assert.equal(f.files.at(-1).value.caption, caption);
  }
});

test('music_bot validates nested actions locally', async t => {
  const f = responsiveClient();
  const runtime = await hostFixture(t, f.client);
  assert.equal(await runtime.run('.music_bot invalid query'), true);
  assert.equal(f.sent.length, 0);
  assert.match(runtime.edits.at(-1).text, /多音源音乐搜索/);
});

test('same-second choices and media at or below the request boundaries are never consumed', async t => {
  const now = 1_900_000_000, clicks = [], files = [];
  const oldChoice = {id: 10, out: false, date: now, buttonCount: 1, async click() { clicks.push('old'); }};
  const oldMedia = {id: 11, out: false, date: now, media: {request: 'old'}};
  const staleAfterBaseline = {id: 15, out: false, date: now, buttonCount: 1, async click() { clicks.push('stale'); }};
  const history = [oldMedia, oldChoice];
  const newChoice = {id: 21, out: false, date: now, buttonCount: 1, async click() {
    clicks.push('new');
    history.unshift({id: 22, out: false, date: now, media: {request: 'new'}});
  }};
  const client = {
    async invoke() {}, async getInputEntity(value) { return value; },
    async getMessages() { return history.slice(); },
    async sendMessage(_bot, value) {
      if (value.message === 'boundary') history.unshift(newChoice, staleAfterBaseline);
      return {id: 20, out: true, date: now};
    },
    async sendFile(_peer, value) { files.push(value.file.request); },
  };
  const runtime = await hostFixture(t, client);
  await runtime.run('.mbvk boundary');
  assert.deepEqual(clicks, ['new']);
  assert.deepEqual(files, ['new']);
});

test('choices and media with missing or nonpositive IDs are rejected', async t => {
  const now = 1_900_000_000, clicks = [], files = [];
  const invalidMedia = {id: 0, out: false, date: now, media: {request: 'invalid'}};
  const invalidChoice = {out: false, date: now, buttonCount: 1, async click() { clicks.push('invalid'); }};
  const history = [];
  const validChoice = {id: 31, out: false, date: now, buttonCount: 1, async click() {
    clicks.push('valid');
    history.unshift({id: 32, out: false, date: now, media: {request: 'valid'}});
  }};
  const client = {
    async invoke() {}, async getInputEntity(value) { return value; },
    async getMessages() { return history.slice(); },
    async sendMessage(_bot, value) {
      if (value.message === 'valid-ids') history.unshift(validChoice, invalidChoice, invalidMedia);
      return {id: 30, out: true, date: now};
    },
    async sendFile(_peer, value) { files.push(value.file.request); },
  };
  const runtime = await hostFixture(t, client);
  await runtime.run('.mbvk valid-ids');
  assert.deepEqual(clicks, ['valid']);
  assert.deepEqual(files, ['valid']);
});

test('media already present before selection is below the click boundary', async t => {
  const now = 1_900_000_000, files = [];
  let sent = false, readsAfterSend = 0;
  const history = [];
  const staleMedia = {id: 22, out: false, date: now, media: {request: 'stale-before-click'}};
  const choice = {id: 21, out: false, date: now, buttonCount: 1, async click() {
    history.unshift({id: 23, out: false, date: now, media: {request: 'fresh-after-click'}});
  }};
  const client = {
    async invoke() {}, async getInputEntity(value) { return value; },
    async getMessages() {
      if (!sent) return [];
      readsAfterSend += 1;
      if (readsAfterSend === 1) return [choice];
      if (readsAfterSend === 2) return [staleMedia, choice];
      return history.slice();
    },
    async sendMessage() { sent = true; history.unshift(choice); return {id: 20, out: true, date: now}; },
    async sendFile(_peer, value) { files.push(value.file.request); },
  };
  const runtime = await hostFixture(t, client);
  await runtime.run('.mbvk click-boundary');
  assert.deepEqual(files, ['fresh-after-click']);
});

test('a failed request sends Start and retries without real-time sleeps', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const startSent = deferred();
  let requestAttempts = 0;
  const f = responsiveClient({beforeSend: async (_bot, request) => {
    if (request === 'retry' && requestAttempts++ === 0) throw new Error('start required');
    if (request === '/start') startSent.resolve();
  }});
  const runtime = await hostFixture(t, f.client);
  const running = runtime.run('.mbvk retry');
  await startSent.promise;
  try {
    await nextTurn();
    t.mock.timers.tick(500);
    await running;
  } finally {
    t.mock.timers.reset();
  }
  assert.deepEqual(f.sent.map(value => value.message), ['retry', '/start', 'retry']);
  assert.equal(f.files[0].value.file.request, 'retry');
});

test('same-bot requests serialize across chats while another bot proceeds independently', async t => {
  const releaseFirst = deferred(), firstStarted = deferred(), secondNative = deferred();
  const f = responsiveClient({beforeSend: async (_bot, request) => {
    if (request === 'first') { firstStarted.resolve(); await releaseFirst.promise; }
  }});
  const runtime = await hostFixture(t, f.client, {onNative(index) { if (index === 1) secondNative.resolve(); }});
  const first = runtime.run('.mbvk first');
  await firstStarted.promise;
  const second = runtime.run('.mbvk second');
  await secondNative.promise;
  const other = runtime.run('.mbym other');
  await other;
  assert.deepEqual(f.sent.map(value => value.message), ['first', 'other']);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.sent.map(value => value.message), ['first', 'other', 'second']);
});

test('an explicitly cancelled middle waiter never sends and cannot let its successor pass the predecessor', async t => {
  const releaseFirst = deferred(), firstStarted = deferred(), allNative = deferred();
  const middleScope = new ResourceScope();
  const f = responsiveClient({beforeSend: async (_bot, request) => {
    if (request === 'first') { firstStarted.resolve(); await releaseFirst.promise; }
  }});
  const runtime = await hostFixture(t, f.client, {
    operationSignals: [undefined, middleScope],
    onNative(index) { if (index === 2) allNative.resolve(); },
  });
  const first = runtime.run('.mbvk first');
  await firstStarted.promise;
  let middleSettled = false;
  const middle = runtime.run('.mbvk middle').then(() => { middleSettled = true; });
  const third = runtime.run('.mbvk third');
  await allNative.promise;
  middleScope.abort(new DOMException('cancelled', 'AbortError'));
  await nextTurn();
  const settledBeforeRelease = middleSettled;
  const sentBeforeRelease = f.sent.map(value => value.message);
  releaseFirst.resolve();
  await Promise.all([first, middle, third]);
  await middleScope.drain(0);
  assert.equal(settledBeforeRelease, true, 'cancelled queue wait should settle immediately');
  assert.deepEqual(sentBeforeRelease, ['first']);
  assert.deepEqual(f.sent.map(value => value.message), ['first', 'third']);
  assert.ok(f.events.indexOf('file:first') < f.events.indexOf('send:third'));
});

test('a failed operation releases the next same-bot request', async t => {
  let fileCalls = 0;
  const f = responsiveClient({onFile: async () => {
    if (++fileCalls === 1) throw new Error('forward failed');
  }});
  const runtime = await hostFixture(t, f.client);
  await Promise.all([runtime.run('.mbvk fails'), runtime.run('.mbvk succeeds')]);
  assert.deepEqual(f.sent.map(value => value.message), ['fails', 'succeeds']);
  assert.equal(f.files.at(-1).value.file.request, 'succeeds');
  assert.equal(runtime.errors.length, 1);
});

test('plugin instances isolate queues across hosts and after unload/reload', async t => {
  const releaseOld = deferred(), oldStarted = deferred();
  const oldClient = responsiveClient({beforeSend: async (_bot, request) => {
    if (request === 'old') { oldStarted.resolve(); await releaseOld.promise; }
  }});
  const independentClient = responsiveClient();
  const oldRuntime = await hostFixture(t, oldClient.client);
  const independentRuntime = await hostFixture(t, independentClient.client);
  const oldRun = oldRuntime.run('.mbvk old');
  await oldStarted.promise;
  let independentDone = false;
  const independent = independentRuntime.run('.mbvk independent').then(() => { independentDone = true; });
  await nextTurn();
  const isolatedBeforeRelease = independentDone;

  const unloading = oldRuntime.host.unload('music_bot', 2000);
  await nextTurn();
  releaseOld.resolve();
  await Promise.all([oldRun, independent, unloading]);
  await oldRuntime.host.load(create());
  await oldRuntime.run('.mbvk reloaded');

  assert.equal(isolatedBeforeRelease, true, 'separate plugin instances must not share a bot queue');
  assert.deepEqual(independentClient.sent.map(value => value.message), ['independent']);
  assert.deepEqual(oldClient.sent.map(value => value.message), ['old', 'reloaded']);
});
