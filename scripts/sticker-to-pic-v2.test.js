'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const packageRoot = process.env.STICKER_TO_PIC_TEST_PACKAGE || path.resolve(__dirname, '../sticker_to_pic');
const {artifactDir} = buildPlugin({id: 'sticker_to_pic', packageRoot, entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP')]);

function sticker(options = {}) {
  const document = Object.assign(Object.create(Api.Document.prototype), {mimeType: options.mimeType ?? 'image/webp',
    attributes: [Object.create(Api.DocumentAttributeSticker.prototype)], ...(options.size === undefined ? {} : {size: options.size})});
  return options.mediaDocument ? {media: {document}} : {media: {}, document};
}

function fixture(options = {}) {
  const edits = [], calls = [], sends = [], deletions = [], logs = [], controller = new AbortController();
  const raw = {peerId: 5};
  const context = {signal: controller.signal, log: {info() {}, error(event) {logs.push(event);}},
    files: {async withTemp(use) {const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-stp-')); let value; try {value = await use(dir, context.signal); context.signal.throwIfAborted();} finally {await fs.rm(dir, {recursive: true, force: true});} if (options.cleanupError) throw new Error('private cleanup'); return value;}},
    processes: {async run(command, args, processOptions) {calls.push({command, args, options: processOptions}); if (options.process) return options.process(command, args); await fs.writeFile(args.at(-1), 'picture'); return {stdout: Buffer.from('ImageMagick 7')};}},
    telegram: {async edit(message, text, editOptions) {edits.push({message, text, options: editOptions});}, async getReply() {return {raw: options.sticker ?? sticker()};},
      async withClient(operation) {return operation({async *iterDownload(_media, downloadOptions) {assert.equal(downloadOptions.signal, controller.signal); for (const chunk of options.chunks ?? [webp]) yield chunk;}, async sendFile(peer, value) {sends.push({peer, value}); if (options.sendFile) return options.sendFile(peer, value);}, async deleteMessages(...args) {deletions.push(args); if (options.deleteError) throw new Error('delete');}}, context.signal);}},
  };
  return {edits, calls, sends, deletions, logs, controller, run: (text, message = {}) => create().commands.stp.handle({command: 'stp', prefix: '.', args: text.split(/\s+/).slice(1), message: {id: 1, chatId: '5', outgoing: true, text, raw, replyToId: 9, ...message}}, context)};
}

test('sticker_to_pic converts transparent PNG in a scoped temporary directory', async () => {
  const f = fixture();
  await f.run('.stp transparent');
  assert.equal(f.calls[0].command, '/usr/bin/magick');
  assert.equal(f.calls[0].args.at(-1).endsWith('.png'), true);
  assert.equal(f.calls[0].args.includes('-background'), false);
  assert.equal(f.sends[0].value.forceDocument, false);
  assert.deepEqual(f.deletions[0], [5, [1], {revoke: true}]);
  assert.deepEqual(f.edits.slice(0, 3).map(item => item.text), ['📥 正在下载贴纸...', '🔄 正在转换为PNG格式...', '📤 正在发送图片...']);
});

test('sticker_to_pic uses flattening args and document mode', async () => {
  const f = fixture();
  await f.run('.stp doc');
  assert.deepEqual(f.calls[0].args.slice(-7, -1), ['-background', 'white', '-alpha', 'remove', '-alpha', 'off']);
  assert.equal(f.sends[0].value.forceDocument, true);
  assert.equal(f.sends[0].value.parseMode, 'html');
  const legacy = fixture();
  await legacy.run('.stp doc transparent');
  assert.equal(legacy.calls[0].args.at(-1).endsWith('.jpg'), true);
  assert.equal(legacy.calls[0].args.includes('-background'), true);
  const png = fixture();
  await png.run('.stp png');
  assert.deepEqual(png.calls[0].args.slice(-5, -1), ['-background', 'white', '-alpha', 'remove']);
});

test('sticker_to_pic accepts a real media.document sticker shape and rejects animated MIME', async () => {
  const real = fixture({sticker: sticker({mediaDocument: true})});
  await real.run('.stp png');
  assert.equal(real.sends.length, 1);
  const animated = fixture({sticker: sticker({mediaDocument: true, mimeType: 'application/x-tgsticker'})});
  await animated.run('.stp');
  assert.equal(animated.sends.length, 0);
  assert.match(animated.edits.at(-1).text, /仅支持 WebP/);
});

test('sticker_to_pic bounds streamed input before conversion', async () => {
  const f = fixture({chunks: [Buffer.alloc(20 * 1024 * 1024 + 1)]});
  await f.run('.stp');
  assert.equal(f.calls.length + f.sends.length + f.deletions.length, 0);
  assert.match(f.edits.at(-1).text, /贴纸转换失败/);
});

test('declared oversize and invalid downloaded formats never reach ImageMagick', async () => {
  const declared = fixture({sticker: sticker({size: 20 * 1024 * 1024 + 1})});
  await declared.run('.stp');
  assert.equal(declared.calls.length + declared.sends.length, 0);
  assert.match(declared.edits.at(-1).text, /20 MiB/);
  const forged = fixture({chunks: [Buffer.from('not-webp-content')]});
  await forged.run('.stp');
  assert.equal(forged.calls.length + forged.sends.length, 0);
  assert.match(forged.edits.at(-1).text, /贴纸转换失败/);
});

test('ImageMagick receives a forced WebP decoder and fixed resource limits in managed cwd', async () => {
  const f = fixture();
  await f.run('.stp');
  const call = f.calls[0], args = call.args;
  assert.deepEqual(args.slice(0, 18), ['-limit', 'width', '512', '-limit', 'height', '512', '-limit', 'memory', '64MiB', '-limit', 'map', '128MiB', '-limit', 'disk', '256MiB', args[15], '-background', 'white']);
  assert.match(args[15], /^webp:.*sticker\.webp\[0\]$/);
  assert.equal(call.options.cwd, path.dirname(args.at(-1)));
  assert.deepEqual(call.options.env, {MAGICK_TEMPORARY_PATH: call.options.cwd});
});

test('successful delivery survives temp cleanup failure without a false conversion error', async () => {
  const f = fixture({cleanupError: true});
  await f.run('.stp');
  assert.equal(f.sends.length, 1);
  assert.equal(f.deletions.length, 1);
  assert.ok(f.logs.includes('sticker_to_pic_temp_cleanup_failed'));
  assert.doesNotMatch(f.edits.map(item => item.text).join('\n'), /贴纸转换失败/);
});

test('delete failure records a fixed event after delivery and preserves the sent result', async () => {
  const f = fixture({deleteError: true});
  await f.run('.stp');
  assert.equal(f.sends.length, 1);
  assert.ok(f.logs.includes('sticker_to_pic_delete_failed'));
  assert.equal(f.edits.at(-1).text, '图片已发送，命令消息删除失败');
});

test('cancellation during upload prevents delete and late receipts', async () => {
  let started, release;
  const ready = new Promise(resolve => {started = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const f = fixture({sendFile: async () => {started(); await gate;}});
  const running = f.run('.stp');
  await ready;
  f.controller.abort();
  release();
  await running;
  assert.equal(f.sends.length, 1);
  assert.equal(f.deletions.length, 0);
  assert.equal(f.edits.at(-1).text, '📤 正在发送图片...');
});

test('sticker_to_pic rejects unknown options before media access', async () => {
  const f = fixture();
  await f.run('.stp nope');
  assert.equal(f.calls.length, 0);
  assert.match(f.edits.at(-1).text, /未知子命令.*nope/);
});

test('sticker_to_pic declares its conversion process budget', () => {
  assert.deepEqual(create().resources.processes, {concurrency: 1, queueCapacity: 2, timeoutMs: 60000, maxOutputBytes: 256 * 1024});
});
