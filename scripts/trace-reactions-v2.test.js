'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'trace-reactions', packageRoot: path.resolve(__dirname, '../trace'), entry: 'v2/reactions.ts'});
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const {sendReactions} = require(path.join(artifactDir, 'index.cjs'));

function fixture() {
  const controller = new AbortController();
  const requests = [], targets = [];
  const peer = new Api.InputPeerSelf();
  const client = {
    async getInputEntity(target) {targets.push(target); return peer;},
    async invoke(request) {requests.push(request);},
  };
  const ctx = {telegram: {withClient: operation => operation(client, controller.signal)}};
  const message = {id: 37, chatId: '-1001234567890', text: 'message', outgoing: false};
  return {controller, requests, targets, peer, client, ctx, message};
}

test('trace sends standard and custom reactions to exact message with full ID precision', async () => {
  const f = fixture();
  await sendReactions(f.ctx, f.message, [{emoticon: '👍'}, {documentId: '9007199254740993'}], true);
  assert.equal(f.targets[0].toString(), '-1001234567890');
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.ok(request instanceof Api.messages.SendReaction);
  assert.equal(request.peer, f.peer);
  assert.equal(request.msgId, 37);
  assert.equal(request.big, true);
  assert.equal(request.reaction[0].emoticon, '👍');
  assert.equal(request.reaction[1].documentId.toString(), '9007199254740993');
});

test('trace preserves native peer instead of resolving a numeric string as username', async () => {
  const f = fixture();
  const peer = new Api.PeerChannel({channelId: require(path.join(core, 'node_modules/big-integer'))(123)});
  f.message.raw = {peerId: peer};
  await sendReactions(f.ctx, f.message, [{emoticon: '❤️‍🔥'}], false);
  assert.equal(f.targets[0], peer);
  assert.equal(f.requests[0].reaction[0].emoticon, '❤️‍🔥');
});

test('trace invalid custom IDs and empty reaction sets never enter native transport', async () => {
  const f = fixture();
  for (const documentId of ['0', '-1', '1.2', '9223372036854775808']) {
    await assert.rejects(sendReactions(f.ctx, f.message, [{documentId}], false));
  }
  await sendReactions(f.ctx, f.message, [], false);
  assert.equal(f.targets.length, 0);
});

test('trace cancellation during peer lookup prevents a subsequent reaction RPC', async () => {
  const f = fixture();
  let release, entered;
  const started = new Promise(resolve => {entered = resolve;});
  f.client.getInputEntity = async () => {entered(); return new Promise(resolve => {release = resolve;});};
  const pending = sendReactions(f.ctx, f.message, [{emoticon: '👍'}], false);
  await started;
  f.controller.abort();
  release(f.peer);
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(f.requests.length, 0);
});
