'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

function loadCheckin() {
  const {artifactDir} = buildPlugin({id: 'checkin', packageRoot: path.resolve(__dirname, '../checkin'), entry: 'v2.ts'});
  return require(path.join(artifactDir, 'index.cjs')).default;
}

async function fixture(t, options = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'mibot-checkin-compat-')));
  const edits = [], replies = [], sent = [];
  const client = {
    async sendMessage(peer, value) {
      sent.push({peer, value});
      if (/请.*回复此消息/.test(value.message)) return {id: 91};
      if (options.onSend) return options.onSend(peer, value);
      return {id: 10};
    },
    async getMessages(peer) { return options.onGet ? options.onGet(peer) : [{id: 11, date: Math.floor(Date.now() / 1000), out: false, message: 'signed'}]; },
    async invoke(request) { if (options.onInvoke) return options.onInvoke(request); return {}; },
  };
  const host = new PluginHost({
    storageRoot: root,
    logger: {info() {}, error() {}},
    telegram: {
      async edit(message, text, options) { edits.push({message, text, options}); },
      async reply(message, text, options) { replies.push({message, text, options}); },
      async invoke(request) { return client.invoke(request); },
      async getReply() { return undefined; },
      async withClient(operation, signal) { return operation(client, options.clientSignal ?? signal); },
    },
  });
  await host.load(loadCheckin()());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fsp.rm(root, {recursive: true, force: true});
  });
  const envelope = (text, extra = {}) => ({id: 1, chatId: '100', senderId: '1', outgoing: true, text, ...extra});
  return {
    edits, replies, sent,
    run: (text, extra) => host.dispatchPrimary(envelope(text, extra)),
    listen: (text, extra) => host.dispatchListeners(envelope(text, extra)),
  };
}

async function addTarget(f) {
  await f.run('.checkin add storm Storm签到 @storm_bot');
  await f.listen('/sign account 123', {id: 2, replyToId: 91});
}

test('empty command retains the legacy help behavior when no targets exist', async t => {
  const f = await fixture(t);
  await f.run('.checkin');
  assert.match(f.edits.at(-1).text, /CheckIn 自动化签到插件/);
  assert.match(f.edits.at(-1).text, /checkin add/);
});

test('set aliases and single-digit hours remain accepted', async t => {
  const f = await fixture(t);
  await f.run('.checkin set t 9:05');
  assert.match(f.edits.at(-1).text, /09:05/);
  await f.run('.checkin set d 7');
  await f.run('.checkin set r 11:30');
  assert.match(f.edits.at(-1).text, /时间范围已更新/);
  await f.run('.checkin set r');
  await f.run('.checkin set l 200');
  assert.match(f.edits.at(-1).text, /日志对话已更新/);
  await f.run('.checkin set b 12345:ABC -100', {saved: true});
  assert.doesNotMatch(f.edits.at(-1).text, /12345:ABC/);
  await f.run('.checkin reset');
  assert.match(f.edits.at(-1).text, /已重置每日运行状态/);
  await f.run('.checkin settings');
  assert.match(f.edits.at(-1).text, /09:05/);
  assert.match(f.edits.at(-1).text, /7 分钟/);
  assert.match(f.edits.at(-1).text, /Bot: 已配置/);
});

test('add prompt and list retain target and matcher details', async t => {
  const f = await fixture(t);
  await f.run('.checkin add storm Storm签到 @storm_bot text:Sign in');
  const prompt = f.edits.at(-1).text;
  assert.match(prompt, /ID: storm/);
  assert.match(prompt, /名称: Storm签到/);
  assert.match(prompt, /目标: @storm_bot/);
  assert.match(prompt, /按钮: Sign in/);
  await f.listen('/sign account 123', {id: 2, replyToId: 91});
  await f.run('.checkin list');
  const list = f.edits.at(-1).text;
  assert.match(list, /1\/1 个启用/);
  assert.match(list, /命令: \/sign account 123/);
  assert.match(list, /按钮: Sign in/);
});

test('test progress/result and manual summary retain legacy context', async t => {
  const f = await fixture(t);
  await addTarget(f);
  await f.run('.checkin test storm');
  assert.ok(f.edits.some(edit => /开始测试签到目标: Storm签到/.test(edit.text)));
  assert.match(f.edits.at(-1).text, /Storm签到.*测试成功/s);
  await f.run('.checkin');
  const summary = f.sent.find(item => item.peer === '100' && /签到汇总报告/.test(item.value.message));
  assert.ok(summary);
  assert.match(summary.value.message, /时间:/);
});

test('error codes are fixed before persistence and summary delivery', async t => {
  const secret = 'TOKEN-private-path';
  const f = await fixture(t, {onSend(peer) {
    if (peer === '@storm_bot') throw Object.assign(new Error('private failure'), {code: secret});
    return {id: 10};
  }});
  await addTarget(f);
  await f.run('.checkin');
  const output = JSON.stringify({edits: f.edits, sent: f.sent});
  assert.doesNotMatch(output, new RegExp(secret));
  assert.doesNotMatch(output, /private failure/);
  assert.match(output, /执行失败/);
});

test('client cancellation during send stops polling and propagates AbortError', async t => {
  const controller = new AbortController();
  let polls = 0;
  const f = await fixture(t, {
    clientSignal: controller.signal,
    onSend(peer) {
      if (peer === '@storm_bot') controller.abort(new DOMException('cancelled', 'AbortError'));
      return {id: 10};
    },
    onGet() { polls++; return []; },
  });
  await addTarget(f);
  await assert.rejects(f.run('.checkin'), {name: 'AbortError'});
  assert.equal(polls, 0);
  assert.equal(f.sent.filter(item => item.peer === '100' && /签到汇总报告/.test(item.value.message)).length, 0);
});

test('client cancellation after getMessages does not inspect or invoke a callback', async t => {
  const controller = new AbortController();
  let invokes = 0;
  const f = await fixture(t, {
    clientSignal: controller.signal,
    onGet() {
      controller.abort(new DOMException('cancelled', 'AbortError'));
      return [{id: 11, date: Math.floor(Date.now() / 1000), out: false, message: 'choose', replyMarkup: {rows: [{buttons: [{text: 'Sign', type: {className: 'InlineButtonTypeCallback', data: Buffer.from('go')}}]}]}}];
    },
    onInvoke() { invokes++; return {}; },
  });
  await f.run('.checkin add storm Storm签到 @storm_bot data:go');
  await f.listen('/sign', {id: 2, replyToId: 91});
  await assert.rejects(f.run('.checkin'), {name: 'AbortError'});
  assert.equal(invokes, 0);
});

test('long commands and names paginate list and summary without exceeding Telegram bounds', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index++) {
    const id = `long-${index}`, name = `${index}-${'名'.repeat(1600)}`;
    await f.run(`.checkin add ${id} ${name} @bot${index}`);
    await f.listen(`/${'x'.repeat(1800)}`, {id: 10 + index, replyToId: 91});
  }
  const beforeListEdits = f.edits.length, beforeListReplies = f.replies.length;
  await f.run('.checkin list');
  const listPages = [...f.edits.slice(beforeListEdits), ...f.replies.slice(beforeListReplies)].map(item => item.text);
  assert.ok(listPages.length > 1);
  assert.ok(listPages.every(page => page.length <= 4096));
  await f.run('.checkin');
  const summaryPages = f.sent.filter(item => item.peer === '100' && /签到汇总报告|\d+\/\d+/.test(item.value.message)).map(item => item.value.message);
  assert.ok(summaryPages.length > 1);
  assert.ok(summaryPages.every(page => page.length <= 4096));
});
