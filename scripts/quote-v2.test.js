'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'quote', packageRoot: path.resolve(__dirname, '../quote'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const sharp = require(path.join(core, 'node_modules/sharp'));

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quote-v2-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const sent = [], edits = [], historyQueries = [], errors = [];
  let deleted = 0;
  const replyRaw = {id: 7, peerId: 'peer', message: '精确引用 <text>', sender: {className: 'User', id: '90071992547409931234', firstName: 'Alice'}, ...(options.replyRaw || {})};
  const reply = {id: 7, chatId: '-10090071992547409939999', senderId: '90071992547409931234', text: replyRaw.message, outgoing: false, raw: replyRaw};
  const commandRaw = {id: 9, peerId: 'peer', message: '.q', sender: {className: 'User', id: '1', firstName: 'Me'}, async delete() {deleted++; if (options.deleteFails) throw new Error('delete failed');}};
  const signal = new AbortController().signal;
  const client = {
    async sendFile(_peer, options) {
      const buffer = await fs.readFile(options.file);
      sent.push({options, buffer, metadata: await sharp(buffer).metadata()});
    },
    async getMessages(_peer, query) {historyQueries.push(query); return options.history || [];},
    async *iterDownload() {if (!options.chunks) throw new Error('no media expected'); for (const chunk of options.chunks) yield chunk;},
  };
  const context = {signal, log: {error(event) {errors.push(event);}}, telegram: {
    async edit(_message, text) {edits.push(text);}, async getReply() {return options.noReply ? undefined : reply;},
    async withClient(operation) {return operation(client, signal);},
  }, files: {async withTemp(operation) {const dir = await fs.mkdtemp(path.join(root, 'job-')); try {return await operation(dir, signal);} finally {await fs.rm(dir, {recursive: true, force: true});}}}};
  const run = (args, text = `.q ${args.join(' ')}`) => create().commands.q.handle({command: 'q', prefix: '.', args,
    message: {id: 9, chatId: reply.chatId, replyToId: 7, text, outgoing: true, raw: commandRaw}}, context);
  return {run, sent, edits, errors, historyQueries, deleted: () => deleted};
}

test('quote exposes structured side-effect-free factory and valid Telegram sticker output', async t => {
  const first = create(), second = create();
  assert.equal(first.apiVersion, 2);
  assert.equal(first.id, 'quote');
  assert.notEqual(first, second);
  assert.ok(first.renderHelp('.').includes('.quote'));
  const f = await fixture(t);
  await f.run([]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].metadata.format, 'webp');
  assert.ok(f.sent[0].buffer.length <= 512 * 1024);
  assert.ok(f.sent[0].metadata.width <= 512 && f.sent[0].metadata.height <= 512);
  assert.ok(f.sent[0].metadata.width === 512 || f.sent[0].metadata.height === 512);
  assert.equal(f.sent[0].options.attributes[0].className, 'DocumentAttributeSticker');
  assert.equal(f.deleted(), 1);
});

test('quote keeps legacy signed range selection and direct-message boundary', async t => {
  const history = [
    {id: 7, peerId: 'peer', message: 'older one', sender: {id: '2', firstName: 'B'}},
    {id: 8, peerId: 'peer', message: 'older two', sender: {id: '3', firstName: 'C'}},
  ];
  const f = await fixture(t, {noReply: true, history});
  await f.run(['-3', 'hidden', 'crop']);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.historyQueries[0], {maxId: 9, limit: 2});
});

test('quote rejects a small compressed image above the pixel budget', async t => {
  const image = await sharp({create: {width: 4600, height: 4600, channels: 3, background: '#ffffff'}}).png().toBuffer();
  assert.ok(image.length < 12 * 1024 * 1024);
  const f = await fixture(t, {replyRaw: {media: {}, photo: {}}, chunks: [image]});
  await f.run([]);
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1), /引用生成失败/);
});

test('quote keeps the successful send result when command deletion fails', async t => {
  const f = await fixture(t, {deleteFails: true});
  await f.run([]);
  assert.equal(f.sent.length, 1);
  assert.ok(f.errors.includes('quote_command_cleanup_failed'));
  assert.doesNotMatch(f.edits.at(-1) ?? '', /引用生成失败/);
});

test('quote fake is an explicit subcommand and story output is a bounded PNG', async t => {
  const fake = await fixture(t);
  await fake.run(['fake', '自定义', '内容']);
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].metadata.format, 'webp');
  const story = await fixture(t);
  await story.run(['story', 'no-media']);
  assert.equal(story.sent[0].metadata.format, 'png');
  assert.deepEqual([story.sent[0].metadata.width, story.sent[0].metadata.height], [1080, 1920]);
});

test('quote rejects unknown options and over-limit ranges before sending', async t => {
  const f = await fixture(t);
  await f.run(['unknown-option']);
  await f.run(['51']);
  assert.equal(f.sent.length, 0);
  assert.equal(f.deleted(), 0);
  assert.match(f.edits[0], /无法识别参数/);
  assert.match(f.edits[1], /1-50/);
});
