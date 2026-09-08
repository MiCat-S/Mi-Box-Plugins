'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {prepareArtifact} = require(path.join(core, 'dist/v2/artifacts.js'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
let artifact;
test.before(async () => {
  const built = buildPlugin({id: 'autochangename', packageRoot: path.resolve(__dirname, '../autochangename'), entry: 'v2.ts'});
  artifact = await prepareArtifact(built.artifactDir);
});
test.after(() => artifact?.release());

async function fixture(t, fetch = async () => assert.fail('Unexpected HTTP')) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-acn-')));
  const updates = [], edits = [];
  const client = {
    async getMe() {return {id: 7, firstName: 'Alice', lastName: 'User'};},
    async invoke(request) {
      assert.equal(request.className, 'account.UpdateProfile');
      assert.ok(request.getBytes().length > 0);
      updates.push(request);
      return {};
    },
  };
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch}, telegram: {
    async edit(_message, text) {edits.push(text);}, async reply(_message, text) {edits.push(text);},
    async getReply() {assert.fail('Unexpected reply lookup');}, async invoke() {assert.fail('Unexpected RPC');},
    async withClient(operation, signal) {return operation(client, signal);},
  }});
  await host.load(artifact.create());
  t.after(async () => {assert.equal((await host.shutdown(1000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  const run = text => host.dispatchPrimary({id: 1, chatId: '7', senderId: '7', outgoing: true, text});
  await run('.acn save');
  return {run, updates, edits, read: async () => JSON.parse(await fs.readFile(path.join(root, 'autochangename/autochangename.json'), 'utf8'))};
}

test('acn applies documented styles to dynamic content and preserves the saved name', async t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-01-01T17:00:00Z')});
  const f = await fixture(t);
  await f.run('.acn text add abc123');
  await f.run('.acn text on');
  await f.run('.acn emoji on');
  for (const [style, expected] of [
    ['normal', 'abc123'], ['italic', '𝐚𝐛𝐜𝟏𝟐𝟑'], ['double', '𝕒𝕓𝕔𝟙𝟚𝟛'],
    ['sans', '𝗮𝗯𝗰𝟭𝟮𝟯'], ['mono', '𝚊𝚋𝚌𝟷𝟸𝟹'], ['outline', '𝖺𝖻𝖼𝟣𝟤𝟥'],
  ]) {
    await f.run(`.acn style ${style}`);
    await f.run('.acn update');
    const update = f.updates.at(-1);
    assert.ok(update.firstName.startsWith('Alice '));
    assert.ok(update.firstName.includes(expected), style);
    assert.ok(update.firstName.includes('🕐'), 'clock face matches the local hour');
    assert.equal(update.lastName, 'User');
  }
});

test('acn formats offsets, abbreviations, seasonal timezones and custom labels', async t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-01-01T00:00:00Z')});
  const f = await fixture(t);
  await f.run('.acn tz on');
  for (const [format, expected] of [['GMT', 'GMT+8'], ['UTC', 'UTC+8'], ['offset', '+08:00'], ['simp', 'CST'], ['custom:北京时间', '北京时间']]) {
    await f.run(`.acn tz format ${format}`);
    await f.run('.acn now');
    assert.ok(f.updates.at(-1).firstName.endsWith(expected), format);
  }
  await f.run('.acn tz format simp');
  await f.run('.acn tz Asia/Hong_Kong');
  await f.run('.acn now');
  assert.ok(f.updates.at(-1).firstName.endsWith('HKT'));
  await f.run('.acn tz America/New_York');
  await f.run('.acn now');
  assert.ok(f.updates.at(-1).firstName.endsWith('EST'));
  t.mock.timers.setTime(new Date('2026-07-01T00:00:00Z').getTime());
  await f.run('.acn now');
  assert.ok(f.updates.at(-1).firstName.endsWith('EDT'));
});

test('acn refreshes weather after thirty minutes while nickname updates preserve cache age', async t => {
  const now = new Date('2026-01-01T00:00:00Z').getTime();
  t.mock.timers.enable({apis: ['Date'], now});
  const requests = [];
  const f = await fixture(t, async input => {
    const url = new URL(input);
    requests.push(url);
    if (url.hostname === 'geocoding-api.open-meteo.com') {
      assert.equal(url.searchParams.get('name'), 'Beijing');
      return Response.json({results: [{latitude: 40, longitude: 116}]});
    }
    assert.equal(url.hostname, 'api.open-meteo.com');
    return Response.json({current: {temperature_2m: 12, weather_code: 80}});
  });
  await f.run('.acn weather set 北京');
  await f.run('.acn update');
  assert.equal(requests.length, 2);
  assert.ok(f.updates.at(-1).firstName.includes('🌦️ 12°C'));
  for (const minute of [1, 10, 29]) {
    t.mock.timers.setTime(now + minute * 60_000);
    await f.run('.acn update');
    assert.equal(requests.length, 2);
    assert.equal((await f.read()).users['7'].weather_cache_ts, now);
  }
  t.mock.timers.setTime(now + 31 * 60_000);
  await f.run('.acn update');
  assert.equal(requests.length, 4);
  assert.equal((await f.read()).users['7'].weather_cache_ts, now + 31 * 60_000);
});

test('acn accepts multiline texts and reports the full user configuration', async t => {
  const f = await fixture(t);
  await f.run('.acn text add 第一条\n第二条');
  assert.deepEqual((await f.read()).random_texts, ['第一条', '第二条']);
  await f.run('.acn style mono');
  await f.run('.acn tz format custom:北京时间');
  await f.run('.acn config');
  for (const value of ['Alice', 'User', 'mono', '北京时间', '文案数', '组件顺序', '时钟表情', '天气显示', '天气地点', '天气预览', '昵称更新时间']) assert.ok(f.edits.at(-1).includes(value));
  await f.run('.acn off');
  assert.equal(f.updates.at(-1).firstName, 'Alice');
  assert.equal((await f.read()).users['7'].text_style, 'mono');
});
