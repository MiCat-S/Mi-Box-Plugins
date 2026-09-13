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
const {Api, utils} = require(path.join(core, 'node_modules/teleproto'));
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
      await request.resolve({}, utils);
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

test('acn switches between 12-hour and 24-hour time', async t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-01-01T18:32:00Z')});
  const f = await fixture(t);
  assert.equal((await f.read()).users['7'].hour_format, '24');

  await f.run('.acn time 12');
  assert.match(f.edits.at(-1), /12 小时制/);
  assert.equal((await f.read()).users['7'].hour_format, '12');
  await f.run('.acn update');
  assert.equal(f.updates.at(-1).firstName, 'Alice 02:32 AM');

  await f.run('.acn time 24');
  assert.match(f.edits.at(-1), /24 小时制/);
  assert.equal((await f.read()).users['7'].hour_format, '24');
  await f.run('.acn update');
  assert.equal(f.updates.at(-1).firstName, 'Alice 02:32');

  await f.run('.acn time invalid');
  assert.match(f.edits.at(-1), /time on\/off.*time 12\/24/);
  assert.equal((await f.read()).users['7'].hour_format, '24');
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
  for (const value of ['Alice', 'User', 'mono', '北京时间', '时间制式', '24 小时制', '文案数', '组件顺序', '时钟表情', '天气显示', '天气地点', '天气预览', '昵称更新时间']) assert.ok(f.edits.at(-1).includes(value));
  await f.run('.acn off');
  assert.equal(f.updates.at(-1).firstName, 'Alice');
  assert.equal((await f.read()).users['7'].text_style, 'mono');
});

async function parityFixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-acn-parity-')));
  if (options.initial) {
    await fs.mkdir(path.join(root, 'autochangename'), {recursive: true});
    await fs.writeFile(path.join(root, 'autochangename/autochangename.json'), JSON.stringify(options.initial));
  }
  const edits = [], updates = [], logs = [];
  const client = {
    async getMe() {return options.getProfile ? options.getProfile() : {id: 7, firstName: 'Alice', lastName: 'User'};},
    async invoke(request) {
      assert.equal(request instanceof Api.account.UpdateProfile, true);
      await request.resolve({}, utils);
      assert.ok(request.getBytes().length > 0);
      updates.push(request);
      await options.onInvoke?.(request, updates.length);
      return {};
    },
  };
  const host = new PluginHost({storageRoot: root, prefixes: options.prefixes ?? ['.'], logger: {
    info(event, fields) {logs.push({level: 'info', event, fields});},
    error(event, fields) {logs.push({level: 'error', event, fields});},
  }, http: {fetch: options.fetch ?? (async () => assert.fail('Unexpected HTTP'))}, telegram: {
    async edit(message, text, messageOptions) {edits.push({message, text, options: messageOptions});},
    async reply(message, text, messageOptions) {edits.push({message, text, options: messageOptions});},
    async getReply() {assert.fail('Unexpected reply lookup');}, async invoke() {assert.fail('Unexpected RPC');},
    async withClient(operation, signal) {return operation(client, signal);},
  }});
  const definition = artifact.create();
  await host.load(definition);
  t.after(async () => {assert.equal((await host.shutdown(2000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  const run = (text, extra = {}) => host.dispatchPrimary({id: extra.id ?? 1, chatId: '7', senderId: options.senderId ?? '7', outgoing: true, text, ...extra});
  return {
    root, host, definition, edits, updates, logs, run,
    read: async () => JSON.parse(await fs.readFile(path.join(root, 'autochangename/autochangename.json'), 'utf8')),
    fireJob: async () => {
      const jobs = [...host.scheduler.jobs.values()];
      assert.equal(jobs.length, 1);
      await jobs[0].fireOnTick();
    },
  };
}

test('acn uses one structured command tree for both root command spellings', async t => {
  const f = await parityFixture(t, {prefixes: ['<&']});
  assert.equal(f.definition.apiVersion, 2);
  await f.run('<&autochangename help extra');
  assert.match(f.edits.at(-1).text, /天气显示/);
  assert.match(f.edits.at(-1).text, /&lt;&amp;acn save/);
  assert.equal(f.definition.commands.acn.subcommands.on.aliases.includes('enable'), true);
  assert.equal(f.definition.commands.acn.subcommands.off.aliases.includes('disable'), true);
  assert.equal(f.definition.commands.acn.subcommands.tz.aliases.includes('timezone'), true);
  assert.equal(f.definition.commands.acn.subcommands.update.aliases.includes('now'), true);
});

test('setup migrates exact keyed identities and repairs incomplete legacy defaults', async t => {
  const id = '9007199254740993';
  const f = await parityFixture(t, {initial: {
    users: {[id]: {user_id: 9007199254740992, timezone: 'Invalid/Zone', original_first_name: null,
      original_last_name: null, is_enabled: true, mode: 'unknown', last_update: null, text_index: -4, marker: 'keep'}},
    random_texts: ['keep'], extra: 'keep',
  }, senderId: id});
  const state = await f.read();
  assert.equal(state.users[id].user_id, id);
  assert.equal(state.users[id].timezone, 'Asia/Shanghai');
  assert.equal(state.users[id].mode, 'time');
  assert.equal(state.users[id].text_index, 0);
  assert.equal(state.users[id].is_enabled, false);
  assert.equal(state.users[id].marker, 'keep');
  assert.equal(state.extra, 'keep');
});

test('subcommand queries and status retain the original observable controls', async t => {
  const f = await parityFixture(t);
  await f.run('.acn save', {chatType: 'broadcast', raw: {fromId: {className: 'PeerChannel'}}});
  assert.match(f.edits.at(-1).text, /不支持在频道中使用/);
  assert.equal(f.updates.length, 0);
  await f.run('.acn status');
  assert.match(f.edits.at(-1).text, /自动更新: <code>已停止<\/code>/);
  await f.run('.acn save');
  for (const [command, expected] of [
    ['.acn tz', /时区管理/],
    ['.acn tz format', /当前:.*GMT/],
    ['.acn time', /当前:.*开启/],
    ['.acn emoji', /当前:.*关闭/],
    ['.acn show', /显示组件管理/],
  ]) {
    await f.run(command);
    assert.match(f.edits.at(-1).text, expected);
  }
});

test('enabled users apply mode, timezone, style, order and show changes immediately', async t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-01-01T00:00:00Z')});
  const f = await parityFixture(t);
  await f.run('.acn save');
  await f.run('.acn text add focus');
  await f.run('.acn on');
  f.updates.length = 0;
  for (const command of ['.acn mode', '.acn tz Asia/Tokyo', '.acn style mono', '.acn order name,text,time', '.acn show text off']) {
    await f.run(command);
    assert.equal(f.updates.length > 0, true, command);
    f.updates.length = 0;
  }
  await f.run('.acn update');
  assert.equal(f.updates.at(-1).firstName.includes('focus'), false);
});

test('text mode keeps time unless either time control disables it', async t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-01-01T00:00:00Z')});
  const f = await parityFixture(t);
  await f.run('.acn save');
  await f.run('.acn text add focus');
  await f.run('.acn on');

  await f.run('.acn mode');
  assert.match(f.updates.at(-1).firstName, /focus/);
  assert.match(f.updates.at(-1).firstName, /08:00/);

  await f.run('.acn time off');
  assert.doesNotMatch(f.updates.at(-1).firstName, /08:00/);

  await f.run('.acn time on');
  assert.match(f.updates.at(-1).firstName, /08:00/);
  await f.run('.acn show time off');
  assert.equal((await f.read()).users['7'].show_time, true);
  assert.doesNotMatch(f.updates.at(-1).firstName, /08:00/);

  await f.run('.acn show time on');
  assert.match(f.updates.at(-1).firstName, /08:00/);
});

test('save re-anchors clean names without resetting established configuration', async t => {
  const f = await parityFixture(t, {initial: {users: {'7': {user_id: 7, timezone: 'Asia/Tokyo',
    original_first_name: 'Old', original_last_name: 'Name', is_enabled: false, mode: 'both', last_update: '2025-01-01T00:00:00.000Z',
    text_index: 2, text_style: 'mono', display_order: 'name,text,time', marker: 'keep'}}, random_texts: ['focus']},
    getProfile: () => ({id: 7, firstName: 'Alice 12:30 🕐', lastName: 'User 08:00'})});
  await f.run('.acn save');
  const user = (await f.read()).users['7'];
  assert.equal(user.original_first_name, 'Alice');
  assert.equal(user.original_last_name, 'User');
  assert.equal(user.text_style, 'mono');
  assert.equal(user.display_order, 'name,text,time');
  assert.equal(user.marker, 'keep');
  assert.match(f.edits.at(-1).text, /原始昵称已更新/);
  assert.match(f.edits.at(-1).text, /Alice/);
  assert.match(f.edits.at(-1).text, /User/);
});

test('command failures classify flood waits and never expose unknown details', async t => {
  let error = new Error('FLOOD_WAIT_17');
  const f = await parityFixture(t, {getProfile: () => {throw error;}});
  await assert.doesNotReject(f.run('.acn save'));
  assert.match(f.edits.at(-1).text, /等待 17 秒/);
  const secrets = ['/Users/operator/private.json', 'sk-live-private-key', 'token-123', 'https://private.example.test/?key=hidden'];
  error = new Error(secrets.join(' '));
  await assert.doesNotReject(f.run('.acn save'));
  const output = f.edits.at(-1).text;
  assert.match(output, /操作失败，请稍后重试/);
  const logged = JSON.stringify(f.logs);
  for (const secret of secrets) {
    assert.equal(output.includes(secret), false);
    assert.equal(logged.includes(secret), false);
  }
  const errors = f.logs.filter(entry => entry.level === 'error');
  assert.deepEqual(errors.map(entry => entry.event), ['autochangename_command_failed', 'autochangename_command_failed']);
  assert.equal(errors.every(entry => entry.fields === undefined), true);
});

test('profile RPC keeps rate limits and emits only stable failure events', async t => {
  let rpcError;
  const f = await parityFixture(t, {onInvoke: async () => {if (rpcError) throw rpcError;}});
  await f.run('.acn save');
  await f.run('.acn on');
  const afterEnable = f.updates.length;
  await f.fireJob();
  assert.equal(f.updates.length, afterEnable, 'scheduled update observes the 30-second limit');

  const secret = 'FLOOD_WAIT_23 /Users/private/key.json?token=secret';
  rpcError = new Error(secret);
  await f.run('.acn update');
  assert.match(f.edits.at(-1).text, /更新失败/);
  assert.equal((await f.read()).users['7'].is_enabled, false);
  assert.equal(JSON.stringify(f.logs).includes(secret), false);
  assert.deepEqual(f.logs.filter(entry => entry.level === 'error'), [
    {level: 'error', event: 'autochangename_profile_flood_wait', fields: undefined},
  ]);

  rpcError = new Error('USERNAME_NOT_MODIFIED');
  await f.run('.acn update');
  assert.match(f.edits.at(-1).text, /昵称已手动更新/);
});

test('managed job cancels between users and registers exactly once after reload', async t => {
  let entered;
  const started = new Promise(resolve => {entered = resolve;});
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const user = id => ({user_id: id, timezone: 'Asia/Shanghai', original_first_name: `User${id}`, original_last_name: null,
    is_enabled: true, mode: 'time', last_update: null, text_index: 0});
  const f = await parityFixture(t, {initial: {users: {'7': user('7'), '8': user('8')}, random_texts: []},
    onInvoke: async (_request, count) => {if (count === 1) {entered(); await gate;}}});
  await f.fireJob();
  await started;
  const unloading = f.host.unload('autochangename', 1000);
  await new Promise(resolve => setImmediate(resolve));
  release();
  const report = await unloading;
  assert.equal(report.completed, true);
  assert.equal(f.updates.length, 1);
  assert.equal(f.host.snapshot().jobs.jobs, 0);
  await f.host.load(artifact.create());
  assert.equal(f.host.snapshot().jobs.jobs, 1);
});
