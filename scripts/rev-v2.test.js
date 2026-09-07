'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));
const {artifactDir} = buildPlugin({id: 'rev', packageRoot: path.resolve(__dirname, '../rev'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function fixture(reply, options = {}) {
  const edits = [], calls = [], sends = [], invokes = [];
  const raw = {peerId: 4, async delete() {}};
  const context = {signal: new AbortController().signal, log: {info() {}, error() {}},
    files: {async withTemp(use) {const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-rev-')); try {return await use(dir, context.signal);} finally {await fs.rm(dir, {recursive: true, force: true});}}},
    processes: {async run(command, args, runOptions) {calls.push({command, args, options: runOptions}); if (options.processError) throw options.processError; await fs.writeFile(args.at(-1), 'output'); return {stdout: Buffer.alloc(0)};}},
    telegram: {async edit(message, text, options) {edits.push({message, text, options});}, async getReply() {return reply;},
      async withClient(operation) {return operation({async downloadMedia(media, options) {await fs.writeFile(options.outputFile, 'input');}, async sendFile(peer, value) {sends.push({peer, value});},
        async getInputEntity(peer) {return peer;}, async invoke(request) {invokes.push(request);}}, context.signal);}},
  };
  return {edits, calls, sends, invokes, run: (text, message = {}) => create().commands.rev.handle({command: 'rev', prefix: '.', args: text.split(/\s+/).slice(1), message: {id: 1, chatId: '4', outgoing: true, text, raw, ...message}}, context)};
}

async function hostFixture(t, reply) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-rev-host-')));
  const edits = [], invokes = [];
  const host = new PluginHost({storageRoot: root, processes: {timeoutMs: 180_000}, logger: {info() {}, error() {}}, telegram: {
    async edit(message, text, options) {edits.push({message, text, options});},
    async reply() {}, async getReply() {return reply;},
    async withClient(operation, signal) {return operation({
      async getInputEntity(peer) {return peer;},
      async invoke(request) {invokes.push(request);},
    }, signal);},
  }});
  await host.load(create());
  t.after(async () => {await host.shutdown(180_000); await fs.rm(root, {recursive: true, force: true});});
  return {edits, invokes, run: () => host.dispatchPrimary({id: 1, chatId: '4', outgoing: true, text: '.rev', replyToId: 8,
    raw: {peerId: 4, async delete() {}}})};
}

test('rev reverses each line without splitting emoji graphemes', async () => {
  const f = fixture();
  await f.run('.rev A👨‍👩‍👧‍👦B');
  assert.equal(f.edits.at(-1).text, 'B👨‍👩‍👧‍👦A');
});

test('rev preserves Telegram entities when reversing replied Unicode text', async () => {
  const entity = {offset: 1, length: 11, kind: 'bold'};
  const f = fixture({text: 'A👨‍👩‍👧‍👦B', raw: {entities: [entity]}});
  await f.run('.rev', {replyToId: 8});
  assert.equal(f.invokes.length, 1);
  assert.equal(f.invokes[0].message, 'B👨‍👩‍👧‍👦A');
  assert.equal(f.invokes[0].entities[0].offset, 1);
  assert.equal(f.invokes[0].entities[0].length, 11);
});

test('rev remaps cross-line entities without emitting newline-only ranges', {timeout: 180_000}, async t => {
  const text = 'abc\ndef';
  const bold = new Api.MessageEntityBold({offset: 1, length: 5});
  const italic = new Api.MessageEntityItalic({offset: 0, length: 3});
  const originals = [bold, italic].map(entity => ({
    entity, offset: entity.offset, length: entity.length, url: entity.url, userId: entity.userId,
  }));
  const f = await hostFixture(t, {text, raw: {entities: [bold, italic]}});
  await f.run();

  assert.equal(f.invokes.length, 1);
  const request = f.invokes[0];
  assert.ok(request instanceof Api.messages.EditMessage);
  assert.equal(request.message, 'cba\nfed');
  assert.deepEqual(request.entities.map(entity => [entity.className, entity.offset, entity.length]), [
    ['MessageEntityItalic', 0, 3], ['MessageEntityBold', 0, 2], ['MessageEntityBold', 5, 2],
  ]);
  assert.ok(request.entities[0] instanceof Api.MessageEntityItalic);
  assert.ok(request.entities[1] instanceof Api.MessageEntityBold);
  for (const original of originals) assert.deepEqual(
    {offset: original.entity.offset, length: original.entity.length, url: original.entity.url, userId: original.entity.userId},
    {offset: original.offset, length: original.length, url: original.url, userId: original.userId},
  );
});

test('rev drops adjacent semantic half-graphemes instead of creating overlapping entities', {timeout: 180_000}, async t => {
  const text = '👍🏽';
  const link = new Api.MessageEntityTextUrl({offset: 0, length: 2, url: 'https://unicode.test'});
  const mention = new Api.InputMessageEntityMentionName({offset: 2, length: 2, userId: 123n});
  const f = await hostFixture(t, {text, raw: {entities: [link, mention]}});
  await f.run();

  assert.equal(f.invokes.length, 0);
  assert.equal(f.edits.length, 1);
  assert.equal(f.edits[0].text, text);
  assert.deepEqual([link.offset, link.length, mention.offset, mention.length], [0, 2, 2, 2]);
});

test('rev expands partial formatting but requires complete graphemes for semantic entities', {timeout: 180_000}, async t => {
  const text = 'A👨‍👩‍👧‍👦👍🏽e\u0301Z';
  const family = new Api.MessageEntityBold({offset: 2, length: 1});
  const skin = new Api.MessageEntityItalic({offset: 13, length: 1});
  const accent = new Api.MessageEntityTextUrl({offset: 17, length: 1, url: 'https://unicode.test'});
  const emoji = new Api.MessageEntityCustomEmoji({offset: 12, length: 4, documentId: 456n});
  const f = await hostFixture(t, {text, raw: {entities: [family, skin, accent, emoji]}});
  await f.run();

  const request = f.invokes[0];
  assert.equal(request.message, 'Ze\u0301👍🏽👨‍👩‍👧‍👦A');
  assert.equal(request.message.isWellFormed(), true);
  assert.deepEqual(request.entities.map(entity => [entity.className, entity.offset, entity.length]), [
    ['MessageEntityItalic', 3, 4], ['MessageEntityCustomEmoji', 3, 4], ['MessageEntityBold', 7, 11],
  ]);
  assert.equal(request.entities[1].documentId, 456n);
  assert.ok(request.entities[1] instanceof Api.MessageEntityCustomEmoji);
  assert.deepEqual([family.offset, family.length, skin.offset, skin.length, accent.offset, accent.length,
    emoji.offset, emoji.length, emoji.documentId], [2, 1, 13, 1, 17, 1, 12, 4, 456n]);
  for (const entity of request.entities) {
    assert.equal(request.message.slice(entity.offset, entity.offset + entity.length).isWellFormed(), true);
  }
});

test('rev preserves valid formatting and link nesting with entity attributes', {timeout: 180_000}, async t => {
  const bold = new Api.MessageEntityBold({offset: 0, length: 4});
  const link = new Api.MessageEntityTextUrl({offset: 1, length: 2, url: 'https://example.test/path'});
  const f = await hostFixture(t, {text: 'abcd', raw: {entities: [bold, link]}});
  await f.run();

  const request = f.invokes[0];
  assert.equal(request.message, 'dcba');
  assert.deepEqual(request.entities.map(entity => [entity.className, entity.offset, entity.length]), [
    ['MessageEntityBold', 0, 4], ['MessageEntityTextUrl', 1, 2],
  ]);
  assert.equal(request.entities[1].url, 'https://example.test/path');
  assert.ok(request.entities[0] instanceof Api.MessageEntityBold);
  assert.ok(request.entities[1] instanceof Api.MessageEntityTextUrl);
});

test('rev resolves illegal semantic overlap by retaining the first source entity', {timeout: 180_000}, async t => {
  const link = new Api.MessageEntityTextUrl({offset: 0, length: 3, url: 'https://example.test/path'});
  const mention = new Api.InputMessageEntityMentionName({offset: 1, length: 1, userId: 123n});
  const linkFirst = await hostFixture(t, {text: 'abc', raw: {entities: [link, mention]}});
  const mentionFirst = await hostFixture(t, {text: 'abc', raw: {entities: [mention, link]}});
  await linkFirst.run();
  await mentionFirst.run();

  assert.deepEqual(linkFirst.invokes[0].entities.map(entity => entity.className), ['MessageEntityTextUrl']);
  assert.equal(linkFirst.invokes[0].entities[0].url, 'https://example.test/path');
  assert.deepEqual(mentionFirst.invokes[0].entities.map(entity => entity.className), ['InputMessageEntityMentionName']);
  assert.equal(mentionFirst.invokes[0].entities[0].userId, 123n);
});

test('rev rejects code nesting while retaining unrelated formatting', {timeout: 180_000}, async t => {
  const code = new Api.MessageEntityCode({offset: 0, length: 3});
  const bold = new Api.MessageEntityBold({offset: 1, length: 1});
  const underline = new Api.MessageEntityUnderline({offset: 3, length: 1});
  const f = await hostFixture(t, {text: 'abcd', raw: {entities: [code, bold, underline]}});
  await f.run();

  assert.deepEqual(f.invokes[0].entities.map(entity => [entity.className, entity.offset, entity.length]), [
    ['MessageEntityUnderline', 0, 1], ['MessageEntityCode', 1, 3],
  ]);
});

test('rev trims entity trailing whitespace and drops newline-only ranges', {timeout: 180_000}, async t => {
  const bold = new Api.MessageEntityBold({offset: 0, length: 3});
  const italic = new Api.MessageEntityItalic({offset: 3, length: 1});
  const f = await hostFixture(t, {text: ' ab\n', raw: {entities: [bold, italic]}});
  await f.run();

  assert.equal(f.invokes[0].message, 'ba \n');
  assert.deepEqual(f.invokes[0].entities.map(entity => [entity.className, entity.offset, entity.length]), [
    ['MessageEntityBold', 0, 2],
  ]);
});

test('rev preserves CRLF boundaries across consecutive empty lines', {timeout: 180_000}, async t => {
  const bold = new Api.MessageEntityBold({offset: 0, length: 10});
  const f = await hostFixture(t, {text: 'ab\r\n\r\n\r\ncd', raw: {entities: [bold]}});
  await f.run();

  assert.equal(f.invokes[0].message, 'ba\r\n\r\n\r\ndc');
  assert.deepEqual(f.invokes[0].entities.map(entity => [entity.offset, entity.length]), [[0, 10]]);
});

test('rev ignores zero-length and invalid entities while retaining valid ASCII mapping', {timeout: 180_000}, async t => {
  const valid = new Api.MessageEntityBold({offset: 1, length: 2});
  const entities = [valid,
    new Api.MessageEntityItalic({offset: 1, length: 0}),
    {offset: -1, length: 1}, {offset: 0, length: -1}, {offset: 0.5, length: 1},
    {offset: 0, length: 1.5}, {offset: 3, length: 2}, {offset: Number.MAX_SAFE_INTEGER, length: 1},
  ];
  const f = await hostFixture(t, {text: 'abcd', raw: {entities}});
  await f.run();

  assert.equal(f.invokes[0].message, 'dcba');
  assert.equal(f.invokes[0].entities.length, 1);
  assert.ok(f.invokes[0].entities[0] instanceof Api.MessageEntityBold);
  assert.deepEqual([f.invokes[0].entities[0].offset, f.invokes[0].entities[0].length], [1, 2]);
  assert.deepEqual([valid.offset, valid.length], [1, 2]);
});

test('rev does not retry another ffmpeg path after a non-spawn failure', async () => {
  const error = Object.assign(new Error('failed'), {code: 'TIMED_OUT'});
  const f = fixture({text: '', raw: {media: {}, photo: {}}}, {processError: error});
  await f.run('.rev', {replyToId: 8});
  assert.equal(f.calls.length, 1);
  assert.equal(create().resources.processes.timeoutMs, 180000);
});

test('rev sends fixed ffmpeg filters for replied media', async () => {
  const f = fixture({text: 'caption', raw: {media: {}, photo: {}}});
  await f.run('.rev v c', {replyToId: 8});
  assert.equal(f.calls[0].command, '/usr/bin/ffmpeg');
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['-nostdin', '-y', '-i']);
  assert.equal(f.calls[0].args.includes('vflip,negate'), true);
  assert.equal(f.sends[0].value.caption, 'noitpac');
});

test('rev shows local help for missing input', async () => {
  const f = fixture();
  await f.run('.rev');
  assert.equal(f.calls.length, 0);
  assert.match(f.edits.at(-1).text, /内容反转/);
});
