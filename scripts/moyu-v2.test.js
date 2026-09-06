'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'moyu', packageRoot: path.resolve(__dirname, '../moyu'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function fixture(response, options = {}) {
  const controller = new AbortController();
  const edits = [], events = [], uploads = [], deletions = [];
  const peer = {channelId: 123};
  const message = {id: 7, chatId: '-100123', outgoing: true, text: '.moyu', raw: {peerId: peer}, topicId: 9};
  let fetching = false;
  const ctx = {
    signal: controller.signal,
    http: {async withResponse(url, init, consume, limits) {
      assert.equal(url, 'https://api.52vmy.cn/api/wl/moyu');
      assert.equal(limits.timeoutMs, 15000);
      fetching = true;
      try {return await consume(response, controller.signal);}
      finally {fetching = false;}
    }},
    telegram: {
      async edit(_, text) {edits.push(text);},
      async withClient(operation) {
        assert.equal(fetching, false);
        return operation({
          async sendFile(...args) {
            events.push('send'); uploads.push(args);
            if (options.uploadError) throw new Error('upload');
          },
          async deleteMessages(...args) {
            events.push('delete'); deletions.push(args);
            if (options.deleteError) throw new Error('delete');
          },
        }, controller.signal);
      },
    },
  };
  return {controller, edits, events, uploads, deletions, peer, message,
    run: (args = []) => create().commands.moyu.handle({message, args, command: 'moyu', prefix: '.'}, ctx)};
}

test('moyu uploads after download and deletes command after successful send', async () => {
  const f = fixture(new Response(new Uint8Array([1, 2, 3])));
  await f.run();
  assert.deepEqual(f.events, ['send', 'delete']);
  assert.equal(f.uploads[0][0], f.peer);
  const options = f.uploads[0][1];
  assert.equal(options.file.size, 3);
  assert.equal(options.forceDocument, false);
  assert.equal(options.replyTo, 9);
  assert.match(options.caption, /^摸鱼日报 /);
  assert.deepEqual(f.deletions[0], [f.peer, [7], {revoke: true}]);
  assert.equal(f.edits.length, 1);
});

test('moyu preserves explicit reply target', async () => {
  const f = fixture(new Response('image'));
  f.message.replyToId = 11;
  await f.run();
  assert.equal(f.uploads[0][1].replyTo, 11);
});

for (const scenario of ['oversize', 'abort', 'empty', 'readError']) {
  test(`moyu ${scenario} releases download and never uploads`, async () => {
    let canceled = 0, entered;
    const reading = new Promise(resolve => {entered = resolve;});
    const response = new Response(new ReadableStream({
      start(target) {
        if (scenario === 'oversize') target.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
        if (scenario === 'empty') target.close();
        if (scenario === 'readError') target.error(new Error('network'));
      },
      pull() {entered();},
      cancel() {canceled++;},
    }));
    const f = fixture(response);
    const running = f.run();
    if (scenario === 'abort') {await reading; f.controller.abort();}
    await running;
    assert.equal(response.body.locked, false);
    assert.equal(canceled, ['oversize', 'abort'].includes(scenario) ? 1 : 0);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.deletions.length, 0);
    if (scenario === 'abort') assert.equal(f.edits.length, 1);
    else assert.match(f.edits.at(-1), /获取摸鱼日报失败/);
  });
}

test('moyu rejects HTTP failure and never deletes on upload failure', async () => {
  for (const f of [fixture(new Response('error', {status: 503})),
    fixture(new Response('image'), {uploadError: true})]) {
    await f.run();
    assert.equal(f.deletions.length, 0);
    assert.match(f.edits.at(-1), /获取摸鱼日报失败/);
  }
});

test('moyu reports successful upload separately from command deletion failure', async () => {
  const f = fixture(new Response('image'), {deleteError: true});
  await f.run();
  assert.deepEqual(f.events, ['send', 'delete']);
  assert.equal(f.edits.at(-1), '摸鱼日报已发送，命令消息删除失败');
});

test('moyu help performs no download or upload', async () => {
  const f = fixture(new Response('image'));
  await f.run(['help']);
  assert.equal(f.uploads.length, 0);
  assert.match(f.edits.at(-1), /获取今日摸鱼日报/);
});
