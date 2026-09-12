'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

function definition() {
  const {artifactDir} = buildPlugin({id: 'atall', packageRoot: path.resolve(__dirname, '../atall'), entry: 'v2.ts'});
  return require(path.join(artifactDir, 'index.cjs')).default();
}

async function fixture(t, iterator, deleteMessage = async () => {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-atall-v2-')));
  const sent = [], edits = [], logs = [];
  let nativeCalls = 0;
  const peer = {className: 'PeerChannel', channelId: 9007199254740993123n};
  const host = new PluginHost({storageRoot: root, logger: {info(label){logs.push(label);}, error(label){logs.push(label);}}, telegram: {
    async edit(_message, text){edits.push(text);}, async reply(){assert.fail('unexpected reply');},
    async invoke(){assert.fail('unexpected invoke');}, async getReply(){return undefined;},
    async withClient(operation, signal){nativeCalls += 1; return operation({
      async getParticipants(){assert.fail('must not load the full participant list');},
      iterParticipants(received){assert.equal(received, peer); return iterator();},
      async sendMessage(received, options){assert.equal(received, peer); sent.push(options);},
    }, signal);},
  }});
  await host.load(definition());
  t.after(async () => {assert.equal((await host.shutdown(2000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  const run = (id = 7, extra = {}) => host.dispatchPrimary({id, chatId: '-1009007199254740993', senderId: '1',
    outgoing: true, chatType: 'supergroup', text: '.atall', raw: {peerId: peer, delete: deleteMessage}, ...extra});
  return {host, sent, edits, logs, run, nativeCalls: () => nativeCalls};
}

function participants(count) {
  return async function* () {
    for (let index = 0; index < count; index++) {
      yield {id: 9007199254740993200n + BigInt(index), firstName: `成员 ${index}`, bot: false, deleted: false};
    }
  };
}

test('atall streams participants and publishes no more than 25 mentions per page', async t => {
  let deleted = 0;
  const f = await fixture(t, participants(26), async () => {deleted += 1;});
  await f.run();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent.map(page => (page.message.match(/tg:\/\/user\?id=/g) ?? []).length), [25, 1]);
  assert.equal(f.sent[0].replyTo, 7);
  assert.equal(f.sent[1].replyTo, undefined);
  assert.equal(deleted, 1);
});

test('atall stops at 250 mentions and 10 pages and reports truncation', async t => {
  const f = await fixture(t, participants(300), async () => {throw new Error('delete denied');});
  await f.run();
  assert.equal(f.sent.length, 10);
  assert.equal(f.sent.reduce((total, page) => total + (page.message.match(/tg:\/\/user\?id=/g) ?? []).length, 0), 250);
  assert.match(f.sent.at(-1).message, /已达到单次 250 人 \/ 10 页上限/);
  assert.equal(f.logs.includes('atall_receipt_cleanup_failed'), true);
  assert.equal(f.edits.some(text => /提醒失败/.test(text)), false);
});

test('atall rejects a concurrent second run before opening another native client', async t => {
  let started;
  const entered = new Promise(resolve => {started = resolve;});
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const iterator = async function* () {
    started();
    await gate;
    yield {id: 9007199254740993200n, firstName: '成员', bot: false, deleted: false};
  };
  const f = await fixture(t, iterator);
  const first = f.run(8);
  await entered;
  await f.run(9);
  assert.match(f.edits.at(-1), /已有 AtAll 任务正在执行/);
  assert.equal(f.nativeCalls(), 1);
  release();
  await first;
  assert.equal(f.sent.length, 1);
});

test('atall command is not admitted in private chats', async t => {
  const f = await fixture(t, participants(1));
  assert.equal(await f.run(10, {chatType: 'private'}), false);
  assert.equal(f.nativeCalls(), 0);
  assert.equal(f.sent.length, 0);
});
