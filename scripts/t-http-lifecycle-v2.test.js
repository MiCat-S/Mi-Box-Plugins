'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 't', packageRoot: path.resolve(__dirname, '../t'), entry: 'v2.ts'});
const {stream} = require(path.join(artifactDir, 'index.cjs'));

test('t releases HTTP readers on normal, oversized and cancelled streams', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-t-reader-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));

  const normal = new Response(Buffer.from('voice'));
  await stream(normal, path.join(root, 'normal.bin'), new AbortController().signal, 16);
  assert.equal(normal.body.locked, false);
  assert.equal(await fs.readFile(path.join(root, 'normal.bin'), 'utf8'), 'voice');

  const oversized = new Response(Buffer.from('too-large'));
  await assert.rejects(stream(oversized, path.join(root, 'large.bin'), new AbortController().signal, 3), /too large/i);
  assert.equal(oversized.body.locked, false);

  let cancelled = false;
  const pending = new Response(new ReadableStream({pull() { return new Promise(() => {}); }, cancel() { cancelled = true; }}));
  const controller = new AbortController();
  const running = stream(pending, path.join(root, 'cancel.bin'), controller.signal, 16);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(running, /cancel/i);
  assert.equal(cancelled, true);
  assert.equal(pending.body.locked, false);
});
