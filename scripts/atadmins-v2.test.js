'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {Api, utils} = require(path.join(core, 'node_modules/teleproto'));
const {returnBigInt: integer} = require(path.join(core, 'node_modules/teleproto/Helpers.js'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {messageEnvelope} = require(path.join(core, 'dist/v2/telegram.js'));

const {artifactDir} = buildPlugin({
  id: 'atadmins',
  packageRoot: path.resolve(__dirname, '../atadmins'),
  entry: 'v2.ts',
});
const createAtAdmins = require(path.join(artifactDir, 'index.cjs')).default;

function rawMessage(text, options = {}) {
  const raw = new Api.Message({
    id: options.id ?? 7,
    peerId: options.peerId ?? new Api.PeerChannel({channelId: integer('9007199254740993')}),
    out: true,
    post: options.post ?? false,
    date: 1,
    message: text,
    replyTo: options.replyTo,
  });
  Object.defineProperty(raw, 'delete', {
    configurable: true,
    value: options.deleteReceipt,
  });
  return raw;
}

function envelope(text, options = {}) {
  return messageEnvelope(rawMessage(text, options), {selfId: '42'});
}

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'atadmins-v2-')));
  const edits = [];
  const replies = [];
  const sent = [];
  const wire = [];
  const logs = [];
  let participantCalls = 0;
  const client = {
    async getParticipants(peer, parameters) {
      participantCalls += 1;
      if (options.participantError) throw options.participantError();
      const request = new Api.channels.GetParticipants({
        channel: peer,
        filter: parameters.filter,
        offset: 0,
        limit: 200,
        hash: integer(0),
      });
      await request.resolve({
        async getInputEntity(value) {
          assert.equal(value instanceof Api.PeerChannel, true);
          return new Api.InputPeerChannel({channelId: value.channelId, accessHash: integer(99)});
        },
      }, utils);
      wire.push({peer, filter: parameters.filter, request, bytes: request.getBytes()});
      return options.participants ?? [];
    },
    async sendMessage(peer, value) {
      sent.push({peer, value});
      await options.onSendMessage?.(peer, value);
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    prefixes: options.prefixes ?? ['.'],
    aliases: options.aliases ?? {},
    logger: {
      info(event, fields) { logs.push({level: 'info', event, fields}); },
      error(event, fields) { logs.push({level: 'error', event, fields}); },
    },
    telegram: {
      async edit(message, text, messageOptions) { edits.push({message, text, options: messageOptions}); },
      async reply(message, text, messageOptions) { replies.push({message, text, options: messageOptions}); },
      async invoke() { assert.fail('unexpected invoke'); },
      async getReply() { return undefined; },
      async withClient(operation, signal) { return operation(client, signal); },
    },
  });
  const definition = createAtAdmins();
  await host.load(definition);
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {
    definition,
    host,
    edits,
    replies,
    sent,
    wire,
    logs,
    participantCalls: () => participantCalls,
    dispatch: message => host.dispatchPrimary(message),
  };
}

test('uses structured help and keeps extended help requests on the complete guide', async t => {
  const f = await fixture(t, {prefixes: ['<&']});
  assert.equal(f.definition.apiVersion, 2);
  await f.dispatch(envelope('<&atadmins help extra', {deleteReceipt: undefined}));
  assert.equal(f.participantCalls(), 0);
  assert.match(f.edits.at(-1).text, /智能分片/);
  assert.match(f.edits.at(-1).text, /&lt;&amp;atadmins/);
});

test('rejects real private peers with the original group-only guidance', async t => {
  const f = await fixture(t);
  await f.dispatch(envelope('.atadmins', {
    peerId: new Api.PeerUser({userId: integer(8)}),
    deleteReceipt: undefined,
  }));
  assert.equal(f.participantCalls(), 0);
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1).text, /此命令只能在群组中使用/);
});

test('serializes the native admin filter and preserves default text, paging and topic reply', async t => {
  const participants = [new Api.User({id: integer('9007199254740995'), firstName: 'A < B'})];
  for (let id = 2; id <= 26; id += 1) {
    participants.push(new Api.User({id: integer(id), username: `admin_${id}`}));
  }
  participants.push(new Api.User({id: integer(27), firstName: 'Bot', bot: true}));
  participants.push(new Api.User({id: integer(28), firstName: 'Gone', deleted: true}));
  const f = await fixture(t, {participants});
  await f.dispatch(envelope('.atadmins', {
    replyTo: new Api.MessageReplyHeader({forumTopic: true, replyToMsgId: 52, replyToTopId: 40}),
    deleteReceipt: undefined,
  }));

  assert.equal(f.wire.length, 1);
  assert.equal(f.wire[0].peer instanceof Api.PeerChannel, true);
  assert.equal(f.wire[0].filter instanceof Api.ChannelParticipantsAdmins, true);
  assert.ok(f.wire[0].bytes.length > 0);
  assert.ok(f.wire[0].peer.getBytes().length > 0);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[0].value.message, /^召唤本群所有管理员：\n\n/);
  assert.match(f.sent[0].value.message, /A &lt; B/);
  assert.match(f.sent[0].value.message, / , @admin_2/);
  assert.equal(f.sent[1].value.message, '召唤本群所有管理员：\n\n@admin_26');
  for (const entry of f.sent) {
    assert.equal(entry.value.parseMode, 'html');
    assert.equal(entry.value.replyTo, 52);
    assert.equal(entry.value.topMsgId, 40);
  }
});

test('reports filtered administrator counts when nobody can be mentioned', async t => {
  const f = await fixture(t, {participants: [
    new Api.User({id: integer(1), firstName: 'Bot', bot: true}),
    new Api.User({id: integer(2), firstName: 'Gone', deleted: true}),
  ]});
  await f.dispatch(envelope('.atadmins', {deleteReceipt: undefined}));
  const output = f.edits.at(-1).text;
  assert.match(output, /未找到可召唤的管理员/);
  assert.match(output, /总管理员: 0/);
  assert.match(output, /机器人管理员: 1/);
  assert.match(output, /可召唤: 0/);
});

test('keeps actionable Telegram errors without exposing unknown failure details', async t => {
  let current = new Error('CHAT_ADMIN_REQUIRED');
  const f = await fixture(t, {participantError: () => current});
  const cases = [
    [new Error('CHAT_ADMIN_REQUIRED'), /需要管理员权限/],
    [new Error('CHANNEL_PRIVATE'), /无法访问此群组的管理员信息/],
    [new Error('FLOOD_WAIT_17'), /等待 17 秒后重试/],
  ];
  for (const [error, expected] of cases) {
    current = error;
    await f.dispatch(envelope(`.atadmins run-${f.edits.length}`, {deleteReceipt: undefined}));
    assert.match(f.edits.at(-1).text, expected);
  }

  const secrets = [
    '/Users/operator/.config/telebox/private.json',
    'sk-live-private-api-key',
    'telegram-token-123456',
    'https://private.example.test/admins?key=hidden',
  ];
  current = new Error(`request failed at ${secrets.join(' ')}`);
  await f.dispatch(envelope('.atadmins unknown', {deleteReceipt: undefined}));
  const output = f.edits.at(-1).text;
  assert.match(output, /暂时无法获取管理员列表，请稍后重试/);
  const logged = JSON.stringify(f.logs);
  for (const secret of secrets) {
    assert.equal(output.includes(secret), false);
    assert.equal(logged.includes(secret), false);
  }
  assert.deepEqual(f.logs.filter(entry => entry.level === 'error').map(entry => entry.event),
    ['atadmins_failed', 'atadmins_failed', 'atadmins_failed', 'atadmins_failed']);
  assert.equal(f.logs.filter(entry => entry.level === 'error').every(entry => entry.fields === undefined), true);
});

test('keeps delayed receipt deletion inside the cancellable host operation', async t => {
  let releaseSend;
  const sent = new Promise(resolve => { releaseSend = resolve; });
  let allowSend;
  const sendGate = new Promise(resolve => { allowSend = resolve; });
  let deleted = 0;
  const f = await fixture(t, {
    participants: [new Api.User({id: integer(1), username: 'admin'})],
    async onSendMessage() { releaseSend(); await sendGate; },
  });
  const running = f.dispatch(envelope('.atadmins', {deleteReceipt: async () => { deleted += 1; }}));
  await sent;
  assert.equal(deleted, 0);
  allowSend();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(deleted, 0, 'the command receipt remains visible during the original grace period');
  const report = await f.host.unload('atadmins', 1000);
  assert.equal(report.completed, true);
  assert.equal(await running, true);
  assert.equal(deleted, 0, 'unload cancels the pending deletion before its side effect');
});

test('receipt deletion failure is non-fatal after the grace period', async t => {
  const f = await fixture(t, {participants: [new Api.User({id: integer(1), username: 'admin'})]});
  await f.dispatch(envelope('.atadmins', {deleteReceipt: async () => { throw new Error('delete denied'); }}));
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(f.edits.at(-1).text, /提醒管理员失败/);
  assert.equal(f.logs.some(entry => entry.event.includes('atadmins_receipt_cleanup_failed')), true);
});
