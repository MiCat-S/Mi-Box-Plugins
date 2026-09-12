'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const esbuild = require(path.join(core, 'node_modules/esbuild'));
const {Api} = require(path.join(core, 'node_modules/teleproto'));

async function load(t, entry, name) {
  const root = await fs.mkdtemp(path.join(core, 'dist', `mibot-yvlu-${name}-`));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const output = path.join(root, `${name}.cjs`);
  esbuild.buildSync({entryPoints: [path.resolve(__dirname, `../yvlu/v2/${entry}`)], outfile: output,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external'});
  return require(output);
}

test('yvlu rejects oversized media before Telegram download', async t => {
  const {downloadMediaBuffer, MAX_MEDIA_BYTES} = await load(t, 'media.ts', 'media');
  let downloads = 0;
  const controller = new AbortController();
  const context = {signal: controller.signal, files: {async withTemp(operation) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-yvlu-download-'));
    try { return await operation(directory, controller.signal); } finally { await fs.rm(directory, {recursive: true, force: true}); }
  }}, telegram: {async withClient(operation) { return operation({async downloadMedia() { downloads += 1; }}, controller.signal); }}};
  await assert.rejects(downloadMediaBuffer(context, {document: {size: MAX_MEDIA_BYTES + 1}}), /20 MiB/);
  assert.equal(downloads, 0);
});

test('yvlu rejects a user photo above the 16M pixel budget before upload', async t => {
  const {saveSticker} = await load(t, 'stickers.ts', 'stickers');
  const media = new Api.MessageMediaPhoto({photo: new Api.PhotoEmpty({id: 1n})});
  const replied = {id: 2, media};
  const bomb = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000"><rect width="100%" height="100%"/></svg>');
  let uploads = 0;
  const controller = new AbortController();
  const client = {
    async invoke(request) {
      if (request instanceof Api.messages.GetStickerSet) throw Object.assign(new Error('missing'), {errorMessage: 'STICKERSET_INVALID'});
      return {};
    },
    async downloadMedia() { return bomb; },
    async uploadFile() { uploads += 1; return {}; },
  };
  const context = {signal: controller.signal, log: {info() {}}, telegram: {
    async getReply() { return {id: 2, chatId: '1', outgoing: false, text: '', raw: replied}; },
    async withClient(operation) { return operation(client, controller.signal); },
  }, files: {async withTemp(operation) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-yvlu-sticker-'));
    try { return await operation(directory, controller.signal); } finally { await fs.rm(directory, {recursive: true, force: true}); }
  }}};
  await assert.rejects(saveSticker(context, {id: 1, chatId: '1', outgoing: true, text: '.yvlu s', replyToId: 2}, 'Quotes'), /pixel limit/i);
  assert.equal(uploads, 0);
});
