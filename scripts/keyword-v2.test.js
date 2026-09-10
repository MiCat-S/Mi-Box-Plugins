'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'keyword', packageRoot: path.resolve(__dirname, '../keyword'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function task(id, key, response, ignoreForward) {
  return {id, chatId: '-1009007199254740993', key, response, include: true, regexp: false, exact: false,
    caseSensitive: false, ignoreForward, reply: true, deleteSource: false, banSeconds: 0, restrictSeconds: 0,
    deleteReplyAfter: 0, deleteSourceAfter: 0};
}

test('keyword admits incoming messages, keeps per-task forwarded filtering and parses the untouched text', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'keyword-host-')));
  await fs.mkdir(path.join(root, 'keyword'));
  await fs.writeFile(path.join(root, 'keyword', 'config.json'), JSON.stringify({
    schemaVersion: 1, nextId: 3, aliases: {}, importedLegacy: true,
    tasks: [task(1, 'hello', 'world', false), task(2, 'secret', 'hidden', true)],
  }));
  const sent = [];
  const edited = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(_message, text) {edited.push(text);},
    async reply() {}, async invoke() {}, async getReply() {},
    async withClient(operation, signal) {
      return operation({async sendMessage(_peer, options) {sent.push(options.message); return {id: 99};}}, signal);
    },
  }});
  t.after(async () => {
    assert.equal((await host.shutdown(3000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  await host.load(create());
  const base = {chatId: '-1009007199254740993', senderId: '9'};
  // The declared incoming direction rejects the account's own message.
  await host.dispatchListeners({...base, id: 1, outgoing: true, text: 'hello'});
  // A forwarded message still matches a task that does not ignore forwards.
  await host.dispatchListeners({...base, id: 2, outgoing: false, forwarded: true, text: 'hello'});
  // A forwarded message never matches a task that declares ignoreForward.
  await host.dispatchListeners({...base, id: 3, outgoing: false, forwarded: true, text: 'secret'});
  // The same task still answers an ordinary incoming message.
  await host.dispatchListeners({...base, id: 4, outgoing: false, text: 'secret'});
  assert.deepEqual(sent, ['world', 'hidden']);
  // The command keeps its original multi-line parser over message.text.
  await host.dispatchPrimary({...base, id: 5, outgoing: true, text: '.keyword 你好\n+++\n欢迎'});
  assert.match(edited.at(-1), /已添加关键词任务/);
  await host.dispatchListeners({...base, id: 6, outgoing: false, text: '你好'});
  assert.equal(sent.at(-1), '欢迎');
});
