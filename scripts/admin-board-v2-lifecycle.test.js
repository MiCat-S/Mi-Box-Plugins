'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

test('admin_board stops issuing demotion RPCs after plugin unload cancellation', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-admin-board-v2-')));
  const {artifactDir} = buildPlugin({id: 'admin_board', packageRoot: path.resolve(__dirname, '../admin_board'), entry: 'v2.ts'});
  const definition = require(path.join(artifactDir, 'index.cjs')).default();
  const target = {className: 'Channel', id: 9007199254740993123n, title: '测试群', username: null};
  const users = [1n, 2n].map((id, index) => ({className: 'User', id: 9007199254740993200n + id,
    firstName: `管理员${index + 1}`, username: null, bot: false,
    participant: {className: 'ChannelParticipantAdmin', rank: ''}}));
  let demotions = 0;
  let entered;
  const firstDemotion = new Promise(resolve => {entered = resolve;});
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const client = {
    async getEntity(){return target;},
    async getParticipants(){return users;},
    async getInputEntity(value){return value;},
    async getMessages(){return [];},
    async invoke(request) {
      if (request && typeof request === 'object' && 'adminRights' in request) {
        demotions += 1;
        if (demotions === 1) {entered(); await gate;}
        return {};
      }
      return {count: 7, messages: []};
    },
  };
  const host = new PluginHost({storageRoot: root, logger: {info(){}, error(){}}, telegram: {
    async edit(){}, async reply(){}, async invoke(){assert.fail('unexpected generic invoke');}, async getReply(){return undefined;},
    async withClient(operation, signal){return operation(client, signal);},
  }});
  await host.load(definition);
  t.after(async () => {assert.equal((await host.shutdown(2000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  const pending = host.dispatchPrimary({id: 7, chatId: '-1009007199254740993', senderId: '1', outgoing: true,
    chatType: 'supergroup', text: '.admin_board rm 2', raw: {peerId: {className: 'PeerChannel'}}});
  await firstDemotion;
  const unloading = host.unload('admin_board', 2000);
  release();
  const [dispatchResult, report] = await Promise.allSettled([pending, unloading]);
  assert.equal(report.status, 'fulfilled');
  assert.equal(report.value.completed, true);
  assert.equal(demotions, 1);
  assert.ok(['fulfilled', 'rejected'].includes(dispatchResult.status));
});
