'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = process.env.TELEBOX_CORE_ROOT || path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'jupai', packageRoot: path.resolve(__dirname, '../jupai'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const sharp = require(path.join(core, 'node_modules/sharp'));
const {Api, helpers, utils} = require(path.join(core, 'node_modules/teleproto'));
const PNG = sharp({create: {width: 2, height: 2, channels: 4, background: '#ff0000ff'}}).png().toBuffer();

function context(options = {}) {
  const controller = options.controller || new AbortController();
  const edits = [], sends = [], logs = [];
  const raw = {peerId: {kind: 'peer'}, async delete() { options.deletes?.(); if (options.deleteError) throw new Error('private delete failure'); }};
  const ctx = {signal: controller.signal, log: {info(event) { logs.push(event); }, error(event) { logs.push(event); }},
    http: {withResponse: async (url, _init, consume, requestOptions) => {
      options.request?.({url: String(url), requestOptions});
      return consume(new Response(options.body || await PNG, {status: options.status || 200}), controller.signal);
    }},
    telegram: {
      async edit(_message, text, settings) { edits.push({text, settings}); },
      async getReply() { return options.reply; },
      async withClient(operation) { return operation({async sendFile(peer, upload) { sends.push({peer, upload}); await options.sendGate; }}, controller.signal); },
    },
  };
  const run = (args, extra = {}) => create().commands.jupai.handle({command: 'jupai', prefix: '!', args,
    message: {id: 7, chatId: '9007199254740993', outgoing: true, text: `!jupai ${args.join(' ')}`, raw, ...extra}}, ctx);
  return {controller, edits, sends, logs, raw, run};
}

test('preserves original peer, reply, no-caption upload and removes the command receipt', async () => {
  let deletes = 0;
  let request;
  const f = context({deletes: () => { deletes += 1; }, request: value => { request = value; }});
  await f.run(['你好', 'world'], {replyToId: 42});
  assert.match(request.url, /msg=%E4%BD%A0%E5%A5%BD%20world$/);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].peer, f.raw.peerId);
  assert.equal(f.sends[0].upload.replyTo, 42);
  assert.equal(f.sends[0].upload.caption, undefined);
  assert.equal(f.sends[0].upload.file.name, 'jupai.jpg');
  assert.equal((await sharp(f.sends[0].upload.file.buffer).metadata()).format, 'jpeg');
  assert.ok(f.sends[0].upload.file.buffer.length <= 5 * 1024 * 1024);
  assert.equal(deletes, 1);
  assert.doesNotMatch(f.edits.at(-1).text, /已发送/);
});

test('preserves validated JPEG bytes and resolves large fallback chat IDs to real TL peers', async () => {
  const jpeg = await sharp({create: {width: 3, height: 2, channels: 3, background: '#00ff00'}}).jpeg({quality: 83}).toBuffer();
  const preserved = context({body: jpeg});
  await preserved.run(['jpeg']);
  assert.deepEqual(preserved.sends[0].upload.file.buffer, jpeg);

  for (const [marked, Peer, field] of [
    ['9007199254740993', Api.PeerUser, 'userId'],
    ['-1009007199254740993', Api.PeerChannel, 'channelId'],
  ]) {
    const f = context({body: jpeg});
    await f.run(['fallback'], {raw: undefined, chatId: marked});
    assert.ok(f.sends[0].peer instanceof Peer);
    const [expected] = utils.resolveId(helpers.returnBigInt(marked));
    assert.equal(f.sends[0].peer[field].toString(), expected.toString());
    assert.equal(utils.getPeerId(f.sends[0].peer), marked);
    assert.ok(f.sends[0].peer.getBytes().length > 0);
  }
});

test('empty input and help aliases use the active prefix without HTTP', async () => {
  assert.deepEqual(create().commands.jupai.helpArgs, ['help', 'h']);
  for (const args of [[], ['help'], ['h']]) {
    let requests = 0;
    const f = context({reply: {text: '   '}, request: () => { requests += 1; }});
    await f.run(args);
    assert.equal(requests, 0);
    assert.match(f.edits.at(-1).text, /<code>!jupai \[文本\]<\/code>/);
  }
});

test('rejects a small encoded image with an excessive decoded pixel count', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000"><rect width="1" height="1"/></svg>');
  const f = context({body: svg});
  await f.run(['large']);
  assert.equal(f.sends.length, 0);
  assert.match(f.edits.at(-1).text, /生成失败/);
});

test('upload cancellation prevents receipt deletion and delete failure remains best effort', async () => {
  let releaseSend;
  const sendGate = new Promise(resolve => { releaseSend = resolve; });
  let deletes = 0;
  const f = context({sendGate, deletes: () => { deletes += 1; }});
  const running = f.run(['cancel']);
  while (!f.sends.length) await new Promise(resolve => setImmediate(resolve));
  f.controller.abort(); releaseSend();
  await running;
  assert.equal(deletes, 0);

  const cleanup = context({deleteError: true});
  await cleanup.run(['ok']);
  assert.equal(cleanup.sends.length, 1);
  assert.ok(cleanup.logs.includes('jupai_receipt_cleanup_failed'));
  assert.ok(!cleanup.edits.some(value => value.text.includes('生成失败')));
});
