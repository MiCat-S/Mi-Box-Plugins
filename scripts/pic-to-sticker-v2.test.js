'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'pic_to_sticker', packageRoot: path.resolve(__dirname, '../pic_to_sticker'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const sharp = require(path.join(core, 'node_modules/sharp'));

async function fixture(t, source, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pts-v2-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  let config = {schemaVersion: 1, defaultEmoji: '🙂', quality: 90, format: 'webp', size: 512, background: 'transparent', autoDelete: options.autoDelete === true, compressionLevel: 6};
  const edits = [], outputs = [], errors = [];
  let deleted = 0;
  const signal = new AbortController().signal;
  const client = {async *iterDownload() {for (const chunk of source.chunks || []) yield chunk;}, async sendFile(_peer, sendOptions) {
    const data = await fs.readFile(sendOptions.file); outputs.push({data, options: sendOptions, metadata: await sharp(data).metadata()});
  }, async getMessages(_peer, query) {return query.minId === source.id ? options.newer || [] : options.older || [];}};
  const context = {signal, log: {error(event) {errors.push(event);}}, storage: {json: () => ({async read() {return structuredClone(config);}, async update(fn) {config = await fn(structuredClone(config)); return config;}})},
    telegram: {async edit(_message, text) {edits.push(text);}, async getReply() {return {id: 2, raw: source};}, async withClient(operation) {return operation(client, signal);}},
    files: {async withTemp(operation) {const dir = await fs.mkdtemp(path.join(root, 'job-')); try {return await operation(dir, signal);} finally {await fs.rm(dir, {recursive: true, force: true});}}}};
  const raw = {peerId: 'peer', async delete() {deleted++; if (options.deleteFails) throw new Error('delete failed');}};
  const run = (args = []) => create().commands.pts.handle({command: 'pts', prefix: '.', args, message: {id: 3, chatId: '1', replyToId: 2, text: `.pts ${args.join(' ')}`, outgoing: true, raw}}, context);
  return {run, edits, outputs, errors, deleted: () => deleted};
}

test('pic_to_sticker streams a bounded input and emits a static Telegram WebP', async t => {
  const gif = await sharp({create: {width: 64, height: 64, channels: 4, background: '#ff0000'}}).gif().toBuffer();
  const f = await fixture(t, {media: {}, document: {size: gif.length}, chunks: [gif]});
  await f.run();
  assert.equal(f.outputs.length, 1);
  assert.equal(f.outputs[0].metadata.format, 'webp');
  assert.equal(f.outputs[0].metadata.pages ?? 1, 1);
  assert.ok(f.outputs[0].data.length <= 512 * 1024);
});

test('pic_to_sticker rejects declared oversized media before downloading', async t => {
  const f = await fixture(t, {media: {}, document: {size: 50 * 1024 * 1024 + 1}, chunks: [Buffer.from('must-not-download')]});
  await f.run();
  assert.equal(f.outputs.length, 0);
  assert.match(f.edits.at(-1), /图片转换失败/);
});

test('pic_to_sticker rejects a small compressed image above the decode pixel budget', async t => {
  const image = await sharp({create: {width: 4600, height: 4600, channels: 3, background: '#ffffff'}}).png().toBuffer();
  assert.ok(image.length < 50 * 1024 * 1024);
  const f = await fixture(t, {media: {}, photo: {}, document: {size: image.length}, chunks: [image]});
  await f.run();
  assert.equal(f.outputs.length, 0);
  assert.match(f.edits.at(-1), /图片转换失败/);
});

test('pic_to_sticker scans both sides of an arbitrary album reply and keeps cleanup failure separate', async t => {
  const image = await sharp({create: {width: 32, height: 32, channels: 4, background: '#0088ff'}}).png().toBuffer();
  const groupedId = 777n;
  const source = {id: 100, groupedId, media: {id: 'source'}, photo: {}, document: {size: image.length}, chunks: [image]};
  const older = [{id: 99, groupedId, media: {id: 'older'}, photo: {}}];
  const newer = [{id: 101, groupedId, media: {id: 'newer'}, document: {mimeType: 'image/png'}}];
  const f = await fixture(t, source, {autoDelete: true, deleteFails: true, older, newer});
  await f.run(['batch']);
  assert.equal(f.outputs.length, 3);
  assert.equal(f.deleted(), 1);
  assert.ok(f.errors.includes('pic_to_sticker_command_cleanup_failed'));
  assert.doesNotMatch(f.edits.at(-1) || '', /图片转换失败/);
});
