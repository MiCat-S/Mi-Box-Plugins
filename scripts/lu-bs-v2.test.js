'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir, manifest} = buildPlugin({
  id: 'lu_bs', packageRoot: path.resolve(__dirname, '../lu_bs'), entry: 'v2.ts',
});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const {returnBigInt: integer} = require(path.join(core, 'node_modules/teleproto/Helpers.js'));

const message = (chatId = '5', raw = {isPrivate: true}) => ({
  id: 1, chatId, senderId: '1', outgoing: true, text: '.lu_bs sub', raw,
});

function fixture(options = {}) {
  let state = structuredClone(options.state ?? {schemaVersion: 1, subscriptions: [], lastMessages: {}});
  let tail = Promise.resolve();
  const edits = [], sent = [], deleted = [], invokes = [], logs = [];
  const client = {
    async getEntity() { return options.entity; },
    async invoke(request) {
      invokes.push(request);
      if (options.stickerError) throw options.stickerError;
      return options.stickerSet ?? {documents: Array.from({length: 12}, (_, id) => ({id}))};
    },
    async deleteMessages(chat, ids) { deleted.push({chat, ids}); },
    async sendFile(chat, value) {
      sent.push({chat, value});
      if (options.sendFile) return options.sendFile(chat, value);
      if (options.sendError?.[chat]) throw options.sendError[chat];
      return {id: Number(chat.replace(/\D/g, '').slice(-6)) || 12};
    },
  };
  const jsonStore = {
    read() { return tail.then(() => structuredClone(state)); },
    update(mutator) {
      const result = tail.then(async () => { state = await mutator(structuredClone(state)); return structuredClone(state); });
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  const context = {
    signal: new AbortController().signal,
    log: {info(event, fields) { logs.push({level: 'info', event, fields}); }, error(event, fields) { logs.push({level: 'error', event, fields}); }},
    storage: {json() { return jsonStore; }},
    telegram: {
      async edit(target, text, settings) { edits.push({target, text, settings}); },
      async withClient(operation) { return operation(client, context.signal); },
    },
  };
  const plugin = create();
  return {
    plugin, context, edits, sent, deleted, invokes, logs,
    state: () => structuredClone(state),
    setup: () => plugin.setup(context),
    run: (text, target = message()) => plugin.commands.lu_bs.handle({
      command: 'lu_bs', prefix: '.', args: text.trim().split(/\s+/).slice(1), message: {...target, text},
    }, context),
    job: () => plugin.jobs.hourly_report.handle(context, context.signal),
  };
}

test('artifact is lazy and declares a stable Shanghai hourly job', () => {
  assert.deepEqual(manifest.imports, ['telebox/sdk', 'teleproto']);
  const plugin = create();
  assert.deepEqual(Object.keys(plugin.jobs), ['hourly_report']);
  assert.equal(plugin.jobs.hourly_report.cron, '0 * * * *');
  assert.equal(plugin.jobs.hourly_report.timeZone, 'Asia/Shanghai');
});

test('setup migrates legacy state idempotently and preserves unknown fields', async () => {
  const f = fixture({state: {
    subscriptions: [5, '5', '-1009007199254740993'],
    lastMessages: {'5': 12n, broken: 'secret'}, future: {kept: true},
  }});
  await f.setup();
  await f.setup();
  assert.deepEqual(f.state(), {
    schemaVersion: 1,
    subscriptions: ['5', '-1009007199254740993'],
    lastMessages: {'5': 12}, future: {kept: true},
  });
});

test('private chats subscribe idempotently, list locally, and unsubscribe', async () => {
  const f = fixture();
  await f.run('.lu_bs sub');
  await f.run('.lu_bs sub');
  assert.deepEqual(f.state().subscriptions, ['5']);
  assert.match(f.edits.at(-1).text, /已经订阅/);
  await f.run('.lu_bs list');
  assert.match(f.edits.at(-1).text, /✅ 已订阅/);
  assert.equal(f.invokes.length, 0);
  await f.run('.lu_bs unsub');
  assert.deepEqual(f.state().subscriptions, []);
});

test('group subscription requires the current account to be an administrator', async () => {
  const admin = new Api.Channel({
    id: integer(100), accessHash: integer(1), title: 'admin', megagroup: true,
    adminRights: new Api.ChatAdminRights({deleteMessages: true}), photo: new Api.ChatPhotoEmpty(), date: 0,
  });
  const allowed = fixture({entity: admin});
  await allowed.run('.lu_bs sub', message('-100', {isChannel: true, peerId: integer(-100)}));
  assert.deepEqual(allowed.state().subscriptions, ['-100']);

  const member = new Api.Channel({
    id: integer(100), accessHash: integer(1), title: 'member', megagroup: true,
    photo: new Api.ChatPhotoEmpty(), date: 0,
  });
  const denied = fixture({entity: member});
  await denied.run('.lu_bs sub', message('-100', {isChannel: true, peerId: integer(-100)}));
  assert.deepEqual(denied.state().subscriptions, []);
  assert.match(denied.edits.at(-1).text, /权限不足/);
});

test('hourly job deletes the previous post and atomically persists the new id', async () => {
  const f = fixture({state: {schemaVersion: 1, subscriptions: ['5'], lastMessages: {'5': 11}}});
  await f.job();
  assert.equal(f.invokes.length, 1);
  assert.deepEqual(f.deleted, [{chat: '5', ids: [11]}]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.state().lastMessages['5'], 5);
});

test('unsubscribe racing an hourly send wins without resurrecting persisted state', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture({
    state: {schemaVersion: 1, subscriptions: ['5'], lastMessages: {'5': 11}},
    sendFile: async () => { await blocked; return {id: 12}; },
  });
  const job = f.job();
  while (!f.sent.length) await new Promise(setImmediate);
  const unsubscribe = f.run('.lu_bs unsub');
  release();
  await Promise.all([job, unsubscribe]);
  assert.deepEqual(f.state().subscriptions, []);
  assert.deepEqual(f.state().lastMessages, {});
});

test('hourly fan-out is bounded and one invalid chat does not affect others', async () => {
  let active = 0, peak = 0;
  const subscriptions = ['-1', '-2', '-3', '-4', '-5', '-6'];
  const f = fixture({
    state: {schemaVersion: 1, subscriptions, lastMessages: {}},
    sendFile: async chat => {
      active += 1; peak = Math.max(peak, active);
      await new Promise(setImmediate);
      active -= 1;
      if (chat === '-3') throw Object.assign(new Error('request failed'), {errorMessage: 'CHAT_WRITE_FORBIDDEN'});
      return {id: 20};
    },
  });
  await f.job();
  assert.equal(peak, 4);
  assert.deepEqual(f.state().subscriptions, ['-1', '-2', '-4', '-5', '-6']);
  assert.equal(f.state().lastMessages['-1'], 20);
  assert.ok(f.logs.some(entry => entry.event === 'lu_bs_subscription_removed' && entry.fields.reason === 'CHAT_WRITE_FORBIDDEN'));
  assert.doesNotMatch(JSON.stringify(f.logs), /request failed/);
});

test('compiled plugin loads and unloads through the real PluginHost', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lu-bs-host-')));
  const host = new PluginHost({
    storageRoot: dir,
    logger: {info() {}, error() {}},
    telegram: {
      async edit() {}, async reply() {}, async invoke() {}, async getReply() {},
      async withClient(operation, signal) { return operation({}, signal); },
    },
  });
  t.after(async () => { await host.shutdown(1000); await fs.rm(dir, {recursive: true, force: true}); });
  await host.load(create());
  assert.equal(host.snapshot().jobs.jobs, 1);
  const report = await host.unload('lu_bs', 1000);
  assert.equal(report.completed, true);
  assert.equal(host.snapshot().jobs.jobs, 0);
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'lu_bs', 'subscriptions.json'), 'utf8'));
  assert.equal(persisted.schemaVersion, 1);
});
