'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'encode', packageRoot: path.resolve(__dirname, '../encode'), entry: 'v2.ts'});
const createEncode = require(path.join(artifactDir, 'index.cjs')).default;
const base = {id: 1, chatId: '123', senderId: '123', outgoing: true, text: '.b64encode Hello'};

async function fixture(t, reply) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-encode-v2-')));
  const edits = [], replies = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(message, text, options) { edits.push({message, text, options}); },
    async reply(message, text, options) { replies.push({message, text, options}); },
    async invoke() { assert.fail('unexpected invoke'); },
    async getReply() { return reply ? {...base, id: 2, text: reply} : undefined; },
    async withClient() { assert.fail('unexpected native call'); },
  }});
  await host.load(createEncode());
  t.after(async () => { assert.equal((await host.shutdown(1000)).completed, true); await fs.rm(root, {recursive: true, force: true}); });
  return {edits, replies, run: text => host.dispatchPrimary({...base, text})};
}

test('encode exposes all commands and transforms text locally', async t => {
  const f = await fixture(t);
  const plugin = createEncode();
  assert.deepEqual(Object.keys(plugin.commands), ['encode', 'b64encode', 'b64decode', 'urlencode', 'urldecode']);
  await f.run('.b64encode Hello 世界');
  assert.match(f.edits.at(-1).text, /SGVsbG8g5LiW55WM/);
  await f.run('.b64decode SGVsbG8g5LiW55WM');
  assert.match(f.edits.at(-1).text, /Hello 世界/);
  await f.run('.urlencode 你好 world');
  assert.match(f.edits.at(-1).text, /%E4%BD%A0%E5%A5%BD%20world/);
});

test('unpadded Base64 and UTF-8 round trip while corrupt encodings fail', async t => {
  const f = await fixture(t);
  await f.run('.b64decode SGk');
  assert.match(f.edits.at(-1).text, /<code>Hi<\/code>/);
  for (const input of ['SGk===', 'S===', '/w==', 'AB==']) {
    await f.run('.b64decode ' + input);
    assert.match(f.edits.at(-1).text, /失败/);
  }
});

test('long results preserve every character with bounded rich-text pages', async t => {
  const f = await fixture(t, '<&😀>'.repeat(1000));
  await f.run('.urlencode');
  const pages = [...f.edits, ...f.replies];
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.text.length < 4096));
  const combined = pages.map(page => page.text.match(/<code>([\s\S]*)<\/code>/)[1]).join('');
  assert.equal(combined, encodeURIComponent('<&😀>'.repeat(1000)));
});

test('missing text names the operation correctly', async t => {
  const f = await fixture(t);
  await f.run('.urlencode');
  assert.match(f.edits.at(-1).text, /要编码的文本/);
  await f.run('.b64decode');
  assert.match(f.edits.at(-1).text, /要解码的文本/);
});

test('encode uses reply text and rejects malformed input safely', async t => {
  const replied = await fixture(t, '回复 <内容>');
  await replied.run('.urlencode');
  assert.match(replied.edits.at(-1).text, /%E5%9B%9E%E5%A4%8D%20%3C%E5%86%85%E5%AE%B9%3E/);
  const invalid = await fixture(t);
  await invalid.run('.b64decode !!!!');
  assert.match(invalid.edits.at(-1).text, /Base64.*失败|失败/);
  assert.doesNotMatch(invalid.edits.at(-1).text, /!!!!/);
});

test('encode help and input limits remain bounded', async t => {
  const f = await fixture(t);
  await f.run('.encode');
  assert.match(f.edits[0].text, /编码解码工具/);
  assert.equal(f.edits[0].options.parseMode, 'html');
  await f.run('.b64encode ' + 'a'.repeat(16_385));
  assert.match(f.edits.at(-1).text, /不能超过/);
});
