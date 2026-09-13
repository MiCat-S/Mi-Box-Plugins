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
const {Api, utils} = require(path.join(core, 'node_modules/teleproto'));
const {artifactDir} = buildPlugin({id: 'annualreport', packageRoot: path.resolve(__dirname, '../annualreport'), entry: 'v2.ts'});
const createPlugin = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-annualreport-v2-')));
  const edits = [], calls = [];
  let dialogFailures = options.dialogFailures ?? 0;
  const client = {
    async getDialogs() {
      calls.push('getDialogs');
      if (options.dialogGate) await options.dialogGate;
      if (dialogFailures > 0) {
        dialogFailures--;
        throw new Error('DIALOGS_UNAVAILABLE');
      }
      return [
        {id: '1', isUser: true, entity: {}}, {id: '2', isUser: true, entity: {bot: true}},
        {id: '3', isGroup: true}, {id: '4', isChannel: true},
      ];
    },
    async invoke(request) {
      calls.push('invoke');
      assert.ok(request instanceof Api.contacts.GetBlocked);
      await request.resolve(client, utils);
      assert.ok(request.getBytes().length > 0);
      if (options.blockedFailure) throw new Error('BLOCKED_UNAVAILABLE');
      return {count: 7, users: []};
    },
    async getMe() {
      calls.push('getMe');
      if (options.accountFailure) throw new Error('SECRET_ACCOUNT_FAILURE');
      return {username: 'alice<&', premium: true};
    },
  };
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}},
    application: options.application,
    http: {fetch: async () => options.httpFailure ? new Response('bad', {status: 500}) : Response.json({hitokoto: '<hello>', from_who: 'author'})},
    telegram: {
      async edit(message, text, settings) { edits.push({message, text, settings}); },
      async reply() { assert.fail('unexpected reply'); }, async invoke() { assert.fail('unexpected invoke'); },
      async getReply() {}, async withClient(operation, signal) { return operation(client, signal); },
    }});
  if (options.initialStats) {
    const directory = path.join(root, 'annualreport');
    await fs.mkdir(directory, {recursive: true});
    await fs.writeFile(path.join(directory, 'stats.json'), JSON.stringify(options.initialStats));
  }
  await host.load(createPlugin());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {host, root, edits, calls, run: (text = '.annualreport') =>
    host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text})};
}

test('annualreport aggregates dialogs, escapes content, and persists report count', async t => {
  const f = await fixture(t);
  await f.run();
  await f.run();
  const text = f.edits.at(-1).text;
  assert.match(text, /@alice&lt;&amp;/);
  assert.match(text, /频道 1 · 群组 1/);
  assert.match(text, /联系人 1 · 机器人 1/);
  assert.match(text, /黑名单 7 人/);
  assert.match(text, /生成报告 2 次/);
  assert.match(text, /&lt;hello&gt;/);
  assert.equal(f.edits.at(-1).settings.parseMode, 'html');
});

test('annualreport falls back safely when quote service fails', async t => {
  const f = await fixture(t, {httpFailure: true});
  await f.run();
  assert.match(f.edits.at(-1).text, /一言开发者中心/);
  assert.doesNotMatch(f.edits.at(-1).text, /bad/);
});

test('annualreport falls back to empty chat stats when dialog collection fails', async t => {
  const f = await fixture(t, {dialogFailures: 2});
  await f.run();
  assert.match(f.edits.at(-1).text, /频道 0 · 群组 0/);
  assert.match(f.edits.at(-1).text, /联系人 0 · 机器人 0/);
  assert.match(f.edits.at(-1).text, /黑名单 7 人/);
  assert.doesNotMatch(f.edits.at(-1).text, /年度报告生成失败/);
});

test('annualreport retries a transient dialog collection failure once', async t => {
  const f = await fixture(t, {dialogFailures: 1});
  await f.run();
  assert.match(f.edits.at(-1).text, /频道 1 · 群组 1/);
  assert.match(f.edits.at(-1).text, /联系人 1 · 机器人 1/);
  assert.equal(f.calls.filter(call => call === 'getDialogs').length, 2);
});

test('annualreport falls back to zero blocked users when the optional RPC fails', async t => {
  const f = await fixture(t, {blockedFailure: true});
  await f.run();
  assert.match(f.edits.at(-1).text, /黑名单 0 人/);
  assert.doesNotMatch(f.edits.at(-1).text, /年度报告生成失败/);
});

test('annualreport keeps fatal account errors generic while retaining the attempt count', async t => {
  const f = await fixture(t, {accountFailure: true});
  await f.run('.annualreport    ignored arguments');
  assert.equal(f.edits.at(-1).text, '年度报告生成失败，请稍后重试');
  assert.doesNotMatch(f.edits.at(-1).text, /SECRET_ACCOUNT_FAILURE/);
  const persisted = JSON.parse(await fs.readFile(path.join(f.root, 'annualreport', 'stats.json'), 'utf8'));
  assert.equal(persisted.reportCount, 1);
});

test('annualreport reports live ready plugin count and preserves historical stats', async t => {
  const startTime = Date.now() - 3 * 86_400_000;
  const f = await fixture(t, {initialStats: {
    startTime, reportCount: 4, legacyMetric: {kept: true},
  }});
  await f.host.load(definePlugin({apiVersion: 1, id: 'extra', description: 'fixture', commands: {}}));

  await f.run();
  assert.match(f.edits.at(-1).text, /已激活插件 2 个/);
  assert.match(f.edits.at(-1).text, /已记录 3 天 · 生成报告 5 次/);
  assert.match(f.edits.at(-1).text, new RegExp(`#${new Date().getMonth() === 0 ? new Date().getFullYear() - 1 : new Date().getFullYear()}年度报告`));

  await f.host.unload('extra');
  await f.run();
  assert.match(f.edits.at(-1).text, /已激活插件 1 个/);
  assert.match(f.edits.at(-1).text, /生成报告 6 次/);
  const persisted = JSON.parse(await fs.readFile(path.join(f.root, 'annualreport', 'stats.json'), 'utf8'));
  assert.equal(persisted.startTime, startTime);
  assert.equal(persisted.reportCount, 6);
  assert.equal(persisted.schemaVersion, 1);
  assert.deepEqual(persisted.legacyMetric, {kept: true});
});

test('annualreport starts fresh-install day tracking when the plugin loads', async t => {
  const installedAt = new Date('2026-09-01T00:00:00Z');
  t.mock.timers.enable({apis: ['Date'], now: installedAt});
  const f = await fixture(t);
  const initialized = JSON.parse(await fs.readFile(path.join(f.root, 'annualreport', 'stats.json'), 'utf8'));
  assert.equal(initialized.startTime, installedAt.getTime());
  assert.equal(initialized.reportCount, 0);
  t.mock.timers.setTime(installedAt.getTime() + 3 * 86_400_000);

  await f.run();
  assert.match(f.edits.at(-1).text, /已记录 3 天/);
});

test('annualreport prefers the application LICENSE timestamp over newer plugin stats', async t => {
  const now = new Date('2026-09-13T00:00:00Z');
  t.mock.timers.enable({apis: ['Date'], now});
  const f = await fixture(t, {
    application: {licenseModifiedAt: now.getTime() - 30 * 86_400_000},
    initialStats: {startTime: now.getTime() - 5 * 86_400_000, reportCount: 0},
  });

  await f.run();
  assert.match(f.edits.at(-1).text, /已记录 30 天/);
});

test('annualreport falls back to plugin stats when LICENSE metadata is absent', async t => {
  const now = new Date('2026-09-13T00:00:00Z');
  t.mock.timers.enable({apis: ['Date'], now});
  const f = await fixture(t, {
    application: {},
    initialStats: {startTime: now.getTime() - 5 * 86_400_000, reportCount: 0},
  });

  await f.run();
  assert.match(f.edits.at(-1).text, /已记录 5 天/);
});

test('annualreport preserves the original negative-day rule for a future LICENSE mtime', async t => {
  const now = new Date('2026-09-13T00:00:00Z');
  t.mock.timers.enable({apis: ['Date'], now});
  const f = await fixture(t, {
    application: {licenseModifiedAt: now.getTime() + 2 * 86_400_000},
    initialStats: {startTime: now.getTime() - 5 * 86_400_000, reportCount: 0},
  });

  await f.run();
  assert.match(f.edits.at(-1).text, /已记录 -2 天/);
});

test('annualreport stops before the next Telegram RPC when unload cancels collection', async t => {
  let releaseDialogs;
  const dialogGate = new Promise(resolve => { releaseDialogs = resolve; });
  const f = await fixture(t, {dialogGate});
  const running = f.run();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(f.calls, ['getDialogs']);
  const shuttingDown = f.host.shutdown(1000);
  releaseDialogs();

  await running;
  assert.equal((await shuttingDown).completed, true);
  assert.deepEqual(f.calls, ['getDialogs']);
  assert.equal(f.edits.length, 1);
});
