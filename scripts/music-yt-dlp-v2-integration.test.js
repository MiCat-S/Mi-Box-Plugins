'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

function factory(id) {
  const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, `../${id}`), entry: 'v2.ts'});
  return require(path.join(artifactDir, 'index.cjs')).default;
}

async function fakeYtDlp(directory) {
  const script = path.join(directory, 'fake-yt-dlp-shared');
  await fs.writeFile(script, [
    '#!/bin/sh',
    'owned=0',
    'if mkdir "$0.lock" 2>/dev/null; then owned=1; else : > "$0.overlap"; fi',
    'cleanup() { if [ "$owned" -eq 1 ]; then rmdir "$0.lock"; fi; }',
    'trap cleanup EXIT INT TERM',
    'probe=0',
    'output=\'\'',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in --dump-single-json) probe=1 ;; -P) shift; output="$1" ;; esac',
    '  shift',
    'done',
    'sleep 0.1',
    'if [ "$probe" -eq 1 ]; then',
    '  printf \'%s\\n\' \'{"title":"Song","uploader":"Artist","duration":60,"filesize_approx":128}\'',
    '  exit 0',
    'fi',
    'printf \'shared-engine-audio\' > "$output/track.mp3"',
  ].join('\n'), {mode: 0o700});
  await fs.chmod(script, 0o700);
  return script;
}

test('music and yt commands retain their IDs while sharing yt-dlp process concurrency', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-music-yt-service-v2-')));
  const executable = await fakeYtDlp(root);
  const sent = [];
  const host = new PluginHost({storageRoot: root, tempRoot: path.join(root, 'temp'), logger: {info(){}, error(){}},
    processes: {concurrency: 2, queueCapacity: 8, timeoutMs: 180000, maxOutputBytes: 2 * 1024 * 1024},
    telegram: {async edit(){}, async reply(){assert.fail('unexpected reply');}, async invoke(){assert.fail('unexpected invoke');},
      async getReply(){return undefined;}, async withClient(operation, signal){return operation({
        async sendFile(_peer, options){sent.push(await fs.readFile(options.file));},
      }, signal);}}});
  await host.load(factory('yt-dlp')({locateTools: async () => ({ytDlp: executable, ffmpeg: '/usr/bin/true'})}));
  await host.load(factory('music')());
  t.after(async () => {assert.equal((await host.shutdown(2000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  const envelope = (id, text) => ({id, chatId: '-1009007199254740993', senderId: '1', outgoing: true,
    chatType: 'supergroup', text, raw: {peerId: {className: 'PeerChannel'}, async delete(){}}});
  const handled = await Promise.all([
    host.dispatchPrimary(envelope(1, '.music first song')),
    host.dispatchPrimary(envelope(2, '.yt second song')),
  ]);
  assert.deepEqual(handled, [true, true]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent, [Buffer.from('shared-engine-audio'), Buffer.from('shared-engine-audio')]);
  await assert.rejects(fs.stat(`${executable}.overlap`), {code: 'ENOENT'});
  await assert.rejects(fs.stat(path.resolve(__dirname, '../music/v2/download.ts')), {code: 'ENOENT'});
});
