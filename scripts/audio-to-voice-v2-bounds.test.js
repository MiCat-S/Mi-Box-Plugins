'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'audio_to_voice', packageRoot: path.resolve(__dirname, '../audio_to_voice'), entry: 'v2.ts'});
const {downloadBounded, removeReceipt, writeAll} = require(path.join(artifactDir, 'index.cjs'));

test('audio_to_voice stops writing before a streamed input exceeds its byte budget', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-audio-to-voice-v2-')));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const output = path.join(directory, 'input-audio');
  const client = {async *iterDownload(){yield Buffer.from('1234'); yield Buffer.from('5678');}};
  await assert.rejects(downloadBounded(client, {}, output, new AbortController().signal, 6), /too large/);
  assert.equal((await fs.stat(output)).size, 4);
});

test('audio_to_voice rejects an empty streamed input and closes the target file', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-audio-to-voice-empty-v2-')));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const output = path.join(directory, 'input-audio');
  const client = {async *iterDownload(){}};
  await assert.rejects(downloadBounded(client, {}, output, new AbortController().signal, 6), /Empty audio/);
  await fs.rename(output, `${output}.closed`);
});

test('audio_to_voice retries partial FileHandle writes until the whole chunk is stored', async () => {
  const pieces = [];
  let writes = 0;
  await writeAll({async write(chunk, offset, length) {
    const bytesWritten = Math.min(2, length);
    pieces.push(Buffer.from(chunk).subarray(offset, offset + bytesWritten));
    writes += 1;
    return {bytesWritten, buffer: chunk};
  }}, Buffer.from('partial-write'));
  assert.equal(Buffer.concat(pieces).toString(), 'partial-write');
  assert.ok(writes > 1);
});

test('audio_to_voice treats command receipt deletion as best-effort after upload', async () => {
  let logged = 0;
  const signal = new AbortController().signal;
  const context = {
    signal,
    log: {info(label){assert.equal(label, 'audio_to_voice_receipt_cleanup_failed'); logged += 1;}},
    telegram: {async withClient(operation){return operation({}, signal);}},
  };
  await removeReceipt(context, {raw: {async delete(){throw new Error('cleanup denied');}}});
  assert.equal(logged, 1);
});
