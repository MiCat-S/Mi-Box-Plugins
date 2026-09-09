'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const {returnBigInt} = require(path.join(core, 'node_modules/teleproto/Helpers'));
const {messageEnvelope} = require(path.join(core, 'dist/v2/telegram.js'));
const {artifactDir} = buildPlugin({id: 'sure', packageRoot: path.resolve(__dirname, '../sure'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function envelope({out = true, chat = 456, from = 789, text = '.sure user add 456', ...patch} = {}) {
  return messageEnvelope(new Api.Message({id: 7, date: 1,
    peerId: new Api.PeerChannel({channelId: returnBigInt(chat)}),
    fromId: new Api.PeerChannel({channelId: returnBigInt(from)}),
    out, message: text, ...patch,
  }), {selfId: '123'});
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-sure-host-')));
  const dir = path.join(root, 'sure');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({users: [], chats: [], messages: {}}));
  const edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}},
    telegram: {
      async edit(_message, text) {edits.push(text);}, async reply() {}, async invoke() {}, async getReply() {},
      async withClient(operation, signal) {return operation({async getMe() {return {id: 123n};}, async sendMessage() {}}, signal);},
    }});
  await host.load(create());
  t.after(async () => {assert.equal((await host.shutdown(1000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  return {edits, run: message => host.dispatchPrimary(message),
    read: async () => JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'))};
}

test('sure rejects a non-owner under full host dispatch and accepts a fresh group send-as owner', async t => {
  const f = await fixture(t);
  // Incoming messages never reach the primary command path.
  assert.equal(await f.run(envelope({out: false})), false);
  assert.deepEqual(f.edits, []);
  assert.deepEqual((await f.read()).users, []);
  // Outgoing messages that reach sure but cannot prove the owner identity are rejected.
  for (const message of [{...envelope(), senderId: '999'}, envelope({post: true}), {...envelope(), forwarded: true}]) {
    assert.equal(await f.run(message), true);
    assert.match(f.edits.at(-1), /只有 owner 可以管理 sure 白名单/);
    assert.deepEqual((await f.read()).users, [], 'rejected messages must not mutate state');
  }
  // A fresh group send-as message from the configured owner is accepted.
  assert.equal(await f.run(envelope()), true);
  assert.match(f.edits.at(-1), /sure user 已添加/);
  assert.deepEqual((await f.read()).users, ['456']);
});
