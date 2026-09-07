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
const {artifactDir} = buildPlugin({id: 'annualreport', packageRoot: path.resolve(__dirname, '../annualreport'), entry: 'v2.ts'});
const createPlugin = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-annualreport-v2-')));
  const edits = [];
  const client = {
    async getDialogs(params) {
      return params?.folder === 1 ? [{id: '4', isChannel: true}] : [
        {id: '1', isUser: true, entity: {}}, {id: '2', isUser: true, entity: {bot: true}},
        {id: '3', isGroup: true}, {id: '4', isChannel: true},
      ];
    },
    async invoke() { return {count: 7, users: []}; },
    async getMe() { return {username: 'alice<&', premium: true}; },
  };
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}},
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
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  return {host, root, edits, run: () => host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text: '.annualreport'})};
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

test('annualreport reports live ready plugin count and preserves historical stats', async t => {
  const startTime = Date.now() - 3 * 86_400_000;
  const f = await fixture(t, {initialStats: {
    schemaVersion: 1, startTime, reportCount: 4, legacyMetric: {kept: true},
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
  assert.deepEqual(persisted.legacyMetric, {kept: true});
});
