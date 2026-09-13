'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

let root, factory;
test.before(async () => {
  root = await fs.mkdtemp(path.join(core, 'temp/botmzt-compat-'));
  const built = buildPlugin({id: 'botmzt', packageRoot: path.resolve(__dirname, '../botmzt'), entry: 'v2.ts', rootDir: core});
  factory = require(path.join(built.artifactDir, built.manifest.entry)).default;
});
test.after(async () => { await fs.rm(root, {recursive: true, force: true}); });

async function run(text, client, options = {}) {
  const edits = [], logs = [];
  const host = new PluginHost({storageRoot: await fs.mkdtemp(path.join(root, 'host-')), prefixes: ['.'],
    logger: {info() {}, error(event, fields) { logs.push({event, fields}); }}, telegram: {
      edit: async (_message, value, settings, signal) => { signal.throwIfAborted(); edits.push({text: value, options: settings}); },
      reply: async () => {}, getReply: async () => undefined, invoke: async () => {},
      withClient: async (operation, signal) => operation(client, signal),
    }});
  await host.load(factory());
  options.onHost?.(host);
  try {
    const handled = await host.dispatchPrimary({id: 9, chatId: '-1001', senderId: '1', text, outgoing: true,
      replyToId: options.replyToId, raw: {id: 9, className: 'Message', peerId: {className: 'PeerChannel', channelId: 1001n},
        ...(options.rawDelete ? {delete: options.rawDelete} : {})}});
    return {handled, edits, logs, host};
  } catch (error) {
    await host.shutdown(1000);
    throw error;
  }
}

test('first image request starts a new bot conversation before requesting the image', async t => {
  const sent = []; let reads = 0;
  const client = {async invoke() {}, async markAsRead() {}, async sendFile() {},
    async sendMessage(peer, value) { sent.push({peer, message: value.message}); },
    async getMessages() { reads += 1; return reads === 1 ? [] : reads === 2
      ? [{id: 1, out: false, message: '欢迎使用'}]
      : [{id: 2, out: false, photo: {id: 1}, media: {photo: true}}]; }};
  const result = await run('.rand', client); t.after(() => result.host.shutdown(1000));
  assert.equal(result.handled, true);
  assert.deepEqual(sent, [
    {peer: '@FinelyGirlsBot', message: '/start'},
    {peer: '@FinelyGirlsBot', message: '/rand'},
  ]);
});

test('image command preserves the bot text error instead of timing out generically', async t => {
  const original = global.setTimeout;
  global.setTimeout = (callback, _delay, ...args) => original(callback, 0, ...args);
  let reads = 0;
  const client = {async invoke() {}, async sendMessage() {},
    async getMessages() { reads += 1; return reads === 1 ? [{id: 3, out: false}] : [{id: 4, out: false, message: '错误：今日额度不足'}]; }};
  try {
    const result = await run('.rand', client); t.after(() => result.host.shutdown(1000));
    assert.match(result.edits.at(-1).text, /机器人返回错误.*今日额度不足/s);
  } finally { global.setTimeout = original; }
});

test('botmzt settings retain details and managed thirty-second deletion', async t => {
  const deletes = [];
  const original = global.setTimeout;
  global.setTimeout = (callback, delay, ...args) => original(callback, delay === 30000 ? 0 : delay, ...args);
  const client = {async deleteMessages(...args) { deletes.push(args); }};
  try {
    const result = await run('.botmzt', client); t.after(() => result.host.shutdown(1000));
    await new Promise(resolve => original(resolve, 20));
    assert.match(result.edits[0].text, /当前配置：/);
    assert.match(result.edits[0].text, /自动删除命令: 已启用/);
    assert.equal(deletes.length, 1);
    assert.equal(String(deletes[0][0]), '-1001');
    assert.deepEqual(deletes[0].slice(1), [[9], {revoke: true}]);
  } finally { global.setTimeout = original; }
});

test('unloading cancels the pending settings deletion', async () => {
  const deletes = [];
  const result = await run('.botmzt', {async deleteMessages(...args) { deletes.push(args); }});
  const report = await result.host.unload('botmzt', 1000);
  assert.equal(report.completed, true);
  assert.equal(deletes.length, 0);
  await result.host.shutdown(1000);
});

test('known Telegram access failures retain actionable feedback', async t => {
  const client = {async invoke() {}, async getMessages() { throw new Error('FLOOD_WAIT_42'); }};
  const result = await run('.qd', client); t.after(() => result.host.shutdown(1000));
  assert.match(result.edits.at(-1).text, /需要等待 42 秒后重试/);
});

test('blocked bot feedback tells the user how to restore access', async t => {
  const client = {async invoke() {}, async getMessages() { throw new Error('USER_BLOCKED'); }};
  const result = await run('.rand', client); t.after(() => result.host.shutdown(1000));
  assert.match(result.edits.at(-1).text, /请先私聊 @FinelyGirlsBot 并发送 \/start/);
});

test('native failures do not leak message, name, or cause into logs and feedback', async t => {
  const secrets = ['token-in-message', 'token-in-name', 'token-in-cause'];
  const failure = new Error(`request failed ${secrets[0]}`, {cause: new Error(secrets[2])});
  failure.name = `RpcError-${secrets[1]}`;
  const client = {async invoke() {}, async getMessages() { throw failure; }};
  const result = await run('.rand', client); t.after(() => result.host.shutdown(1000));
  const visible = JSON.stringify({edits: result.edits, logs: result.logs});
  for (const secret of secrets) assert.equal(visible.includes(secret), false);
  assert.equal(result.logs.at(-1).event, 'botmzt_request_failed');
  assert.equal(result.logs.at(-1).fields, undefined);
  assert.match(result.edits.at(-1).text, /获取图片失败.*请稍后重试/);
});

test('cancellation after initial history read sends no subsequent RPC', async () => {
  const controller = new AbortController(); let sends = 0, invokes = 0;
  const client = {async invoke() { invokes += 1; }, async sendMessage() { sends += 1; },
    async getMessages() { controller.abort(); return []; }};
  const context = {signal: controller.signal, log: {error() {}}, telegram: {
    async edit() {}, async withClient(operation) { return operation(client, controller.signal); },
  }};
  await factory().commands.rand.handle({message: {id: 9, chatId: '-1001', raw: {}}, command: 'rand', prefix: '.', args: []}, context);
  assert.equal(invokes, 1, 'only the best-effort unblock precedes the cancelled read');
  assert.equal(sends, 0);
});

test('cancellation during sendFile prevents mark-as-read and command deletion', async () => {
  const controller = new AbortController(); let reads = 0, marks = 0, deletes = 0;
  const client = {async invoke() {}, async sendMessage() {},
    async getMessages() { reads += 1; return reads === 1 ? [{id: 4, out: false}] : [{id: 5, out: false, media: {photo: true}}]; },
    async sendFile() { controller.abort(); }, async markAsRead() { marks += 1; }};
  const context = {signal: controller.signal, log: {error() {}}, telegram: {
    async edit() {}, async withClient(operation) { return operation(client, controller.signal); },
  }};
  await factory().commands.rand.handle({message: {id: 9, chatId: '-1001', replyToId: 3,
    raw: {peerId: {}, async delete() { deletes += 1; }}}, command: 'rand', prefix: '.', args: []}, context);
  assert.equal(marks, 0);
  assert.equal(deletes, 0);
});

test('command deletion failure does not replace a successfully sent image', async t => {
  let reads = 0;
  const client = {async invoke() {}, async sendMessage() {}, async sendFile() {}, async markAsRead() {},
    async getMessages() { reads += 1; return reads === 1 ? [{id: 6, out: false}] : [{id: 7, out: false, media: {photo: true}}]; }};
  const result = await run('.rand', client, {rawDelete: async () => { throw new Error('delete secret'); }});
  t.after(() => result.host.shutdown(1000));
  assert.equal(result.edits.length, 1, 'only the progress edit is emitted');
  assert.deepEqual(result.logs.at(-1), {event: 'botmzt_command_delete_failed', fields: undefined});
});
