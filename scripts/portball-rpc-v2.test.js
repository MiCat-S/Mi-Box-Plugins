'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'portball', packageRoot: path.resolve(__dirname, '../portball'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const Utils = require(path.join(core, 'node_modules/teleproto/Utils.js'));

test('portball checks exact current/target participants before serializing the ban request', async () => {
  const channelId = 90071992547409931234n, userId = 80071992547409931234n;
  const channel = new Api.Channel({id: channelId, accessHash: 11n, title: 'Group', megagroup: true, photo: new Api.ChatPhotoEmpty(), date: 0});
  const user = new Api.User({id: userId, accessHash: 22n, firstName: 'Target'});
  const inputChannel = new Api.InputPeerChannel({channelId, accessHash: 11n});
  const inputUser = new Api.InputPeerUser({userId, accessHash: 22n});
  const requests = [], edits = [], errors = [];
  const client = {async getEntity(value) {return value === inputChannel ? channel : user;}, async getMe() {return new Api.User({id: 1n, firstName: 'Me'});},
    async getInputEntity(value) {if (value instanceof Api.InputPeerSelf) return value; return value instanceof Api.Channel || value === inputChannel ? inputChannel : inputUser;},
    async invoke(request) {requests.push(request); if (request instanceof Api.channels.GetParticipant) return {participant: request.participant instanceof Api.InputPeerSelf ?
      new Api.ChannelParticipantCreator({userId: 1n}) : new Api.ChannelParticipant({userId, date: 0})}; return {};}, async sendMessage() {return {};}};
  const signal = new AbortController().signal;
  const context = {signal, log: {error(event) {errors.push(event);}}, telegram: {async edit(_message, text) {edits.push(text);}, async getReply() {return {senderId: userId.toString()};}, async withClient(operation) {return operation(client, signal);}}};
  await create().commands.portball.handle({command: 'portball', prefix: '.', args: ['5m'], message: {id: 1, chatId: `-100${channelId}`, replyToId: 2,
    text: '.portball 5m', outgoing: true, raw: {peerId: inputChannel, async delete() {throw new Error('delete failed');}}}}, context);
  assert.equal(requests.filter(value => value instanceof Api.channels.GetParticipant).length, 2);
  const request = requests.find(value => value instanceof Api.channels.EditBanned);
  assert.ok(request);
  await request.resolve(client, Utils);
  assert.equal(request.channel.channelId.toString(), channelId.toString());
  assert.equal(request.participant.userId.toString(), userId.toString());
  assert.ok(request.getBytes().length > 0);
  assert.ok(errors.includes('portball_command_cleanup_failed'));
  assert.doesNotMatch(edits.at(-1) ?? '', /禁言失败/);
});
