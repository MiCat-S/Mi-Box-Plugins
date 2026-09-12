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
  const script = path.join(directory, 'fake-yt-dlp');
  const source = [
    '#!/bin/sh',
    'printf \'%s\\n\' \'---\' >> "$0.args"',
    'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$0.args"; done',
    'probe=0',
    'output=\'\'',
    'config=\'\'',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --dump-single-json) probe=1 ;;',
    '    --config-locations) shift; config="$1" ;;',
    '    -P) shift; output="$1" ;;',
    '  esac',
    '  shift',
    'done',
    'if [ -n "$config" ]; then',
    '  cp "$config" "$0.proxy.snapshot"',
    '  (stat -f \'%Lp\' "$config" 2>/dev/null || stat -c \'%a\' "$config") > "$0.proxy.mode"',
    'fi',
    'if [ "$probe" -eq 1 ]; then',
    '  printf \'%s\\n\' \'{"id":"abcdefghijk","title":"Video Title","uploader":"Video Artist","duration":123,"filesize_approx":4096}\'',
    '  exit 0',
    'fi',
    'printf \'audio-bytes\' > "$output/track.mp3"',
    'printf \'cover-bytes\' > "$output/track.jpg"',
  ].join('\n');
  await fs.writeFile(script, source, {mode: 0o700});
  await fs.chmod(script, 0o700);
  return script;
}

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-music-v2-')));
  if (options.seed) await options.seed(root);
  const executable = await fakeYtDlp(root);
  const edits = [], sent = [], aiCalls = [], imports = [], logs = [];
  let uploadedPath, deleted = 0;
  const host = new PluginHost({storageRoot: root, tempRoot: path.join(root, 'temp'),
    logger: {info(label){logs.push(label);}, error(label){logs.push(label);}},
    processes: {concurrency: 2, queueCapacity: 8, timeoutMs: 180000, maxOutputBytes: 2 * 1024 * 1024},
    telegram: {
      async edit(message, text, editOptions){edits.push({message, text, options: editOptions});},
      async reply(){assert.fail('unexpected reply');}, async invoke(){assert.fail('unexpected invoke');}, async getReply(){return undefined;},
      async withClient(operation, signal){return operation({async sendFile(_peer, sendOptions){
        uploadedPath = sendOptions.file;
        sent.push({...sendOptions, bytes: await fs.readFile(sendOptions.file)});
      }}, signal);},
    }});
  await host.load({apiVersion: 1, id: 'ai', description: 'test ai', commands: {}, services: {
    chat: {description: 'test', async handle(input){aiCalls.push(input); return '歌曲名: Blue\n歌手: Alice\n专辑: Sky';}},
    import_provider: {description: 'test', async handle(input){imports.push(input); return {tag: 'music-imported', imported: true};}},
  }});
  if (options.loadYt !== false) {
    await host.load(factory('yt-dlp')({locateTools: async () => ({ytDlp: executable, ffmpeg: '/usr/bin/true'})}));
  }
  await host.load(factory('music')({...options.dependencies}));
  t.after(async () => {assert.equal((await host.shutdown(2000)).completed, true); await fs.rm(root, {recursive: true, force: true});});
  const run = (text, extra = {}) => host.dispatchPrimary({id: 7, chatId: '-1001234567890123456', senderId: '42',
    outgoing: true, chatType: 'supergroup', text,
    raw: {peerId: {className: 'PeerChannel'}, async delete(){deleted += 1; if (options.deleteFails) throw new Error('delete denied');}},
    ...extra});
  return {root, executable, host, edits, sent, aiCalls, imports, logs, run,
    uploadedPath: () => uploadedPath, deleted: () => deleted};
}

test('music consumes yt-dlp.download_mp3 and keeps proxy credentials out of process argv', async t => {
  const f = await fixture(t, {deleteFails: true});
  await f.run('.music set cookie SID=local-test', {saved: true});
  await f.run('.music set proxy socks5://user:pass@127.0.0.1:1080', {saved: true});
  const settings = await f.host.readSettings('music');
  assert.equal(settings.secretSet.cookie, true);
  assert.equal(settings.secretSet.proxy, true);
  assert.equal(Object.hasOwn(settings.values, 'cookie'), false);
  assert.equal(Object.hasOwn(settings.values, 'proxy'), false);
  await f.run('.music 周杰伦 晴天');
  assert.equal(f.aiCalls.length, 1);
  assert.equal(f.aiCalls[0].text, '周杰伦 晴天');
  assert.equal(Object.hasOwn(f.aiCalls[0], 'video'), false);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].bytes, Buffer.from('audio-bytes'));
  assert.equal(f.sent[0].attributes[0].title, 'Blue');
  assert.equal(f.sent[0].attributes[0].performer, 'Alice');
  await assert.rejects(fs.stat(f.uploadedPath()), {code: 'ENOENT'});
  const args = await fs.readFile(`${f.executable}.args`, 'utf8');
  assert.match(args, /(?:^|\n)--ignore-config(?:\n|$)/);
  assert.match(args, /(?:^|\n)--no-playlist(?:\n|$)/);
  assert.match(args, /(?:^|\n)--match-filter(?:\n|$)/);
  assert.match(args, /(?:^|\n)--max-filesize(?:\n|$)/);
  assert.match(args, /(?:^|\n)--format\nbestaudio\/best(?:\n|$)/);
  assert.match(args, /(?:^|\n)--cookies(?:\n|$)/);
  assert.match(args, /(?:^|\n)--config-locations(?:\n|$)/);
  assert.doesNotMatch(args, /local-test|user:pass/);
  assert.doesNotMatch(args, /(?:^|\n)(?:-U|--update)(?:\n|$)/);
  assert.match(await fs.readFile(`${f.executable}.proxy.snapshot`, 'utf8'), /socks5:\/\/user:pass@127\.0\.0\.1:1080/);
  assert.equal((await fs.readFile(`${f.executable}.proxy.mode`, 'utf8')).trim(), '600');
  assert.equal(f.deleted(), 1);
  assert.equal(f.logs.includes('music_receipt_cleanup_failed'), true);
  assert.equal(f.edits.some(item => /音乐下载失败/.test(item.text)), false);
});

test('music performs no AI or process work when the yt-dlp service is unavailable', async t => {
  const f = await fixture(t, {loadYt: false});
  await f.run('.music 周杰伦 晴天');
  assert.equal(f.aiCalls.length, 0);
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1).text, /需要 yt-dlp 插件提供下载服务/);
  await assert.rejects(fs.stat(`${f.executable}.args`), {code: 'ENOENT'});
});

test('music migrates the legacy Gemini origin to v1beta and scrubs only after import succeeds', async t => {
  const f = await fixture(t, {seed: async root => {
    await fs.mkdir(path.join(root, 'music'), {recursive: true});
    await fs.writeFile(path.join(root, 'music', 'music_config.json'), JSON.stringify({
      music_ytdlp_cookie: 'SID=legacy', music_ytdlp_proxy: 'socks5://127.0.0.1:1080', music_audio_quality: '192kbps',
      music_gemini_api_key: 'legacy-ai-key', music_gemini_base_url: 'https://generativelanguage.googleapis.com',
      music_gemini_model: 'gemini-2.0-flash',
    }));
  }});
  assert.equal(f.imports.length, 1);
  assert.equal(f.imports[0].url, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(f.imports[0].key, 'legacy-ai-key');
  assert.equal(f.imports[0].models.chat, 'gemini-2.0-flash');
  const settings = await f.host.readSettings('music');
  assert.equal(settings.secretSet.cookie, true);
  assert.equal(settings.secretSet.proxy, true);
  assert.equal(settings.values.quality, '192k');
  const legacy = JSON.parse(await fs.readFile(path.join(f.root, 'music', 'music_config.json'), 'utf8'));
  assert.equal(legacy.music_gemini_api_key, '');
  const current = JSON.parse(await fs.readFile(path.join(f.root, 'music', 'config.json'), 'utf8'));
  assert.equal(current.aiMigrated, true);
  assert.equal(current.legacyAi, undefined);
  assert.equal(current.importedAiTag, 'music-imported');
});

test('music retries migration when legacy key scrubbing fails before the success marker', async t => {
  let attempts = 0;
  const f = await fixture(t, {
    seed: async root => {
      await fs.mkdir(path.join(root, 'music'), {recursive: true});
      await fs.writeFile(path.join(root, 'music', 'music_config.json'), JSON.stringify({music_gemini_api_key: 'retry-key'}));
    },
    dependencies: {async scrubLegacyKey(file, raw) {
      attempts += 1;
      if (attempts === 1) throw new Error('simulated scrub failure');
      raw.music_gemini_api_key = '';
      await fs.writeFile(file, `${JSON.stringify(raw)}\n`, {mode: 0o600});
    }},
  });
  let current = JSON.parse(await fs.readFile(path.join(f.root, 'music', 'config.json'), 'utf8'));
  assert.equal(attempts, 1);
  assert.equal(f.imports.length, 1);
  assert.equal(current.aiMigrated, false);
  assert.equal(current.legacyAi.key, 'retry-key');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'music', 'music_config.json'), 'utf8')).music_gemini_api_key, 'retry-key');
  await f.run('.music config');
  current = JSON.parse(await fs.readFile(path.join(f.root, 'music', 'config.json'), 'utf8'));
  assert.equal(attempts, 2);
  assert.equal(f.imports.length, 2);
  assert.equal(current.aiMigrated, true);
  assert.equal(current.legacyAi, undefined);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'music', 'music_config.json'), 'utf8')).music_gemini_api_key, '');
});

test('music set without a child renders focused set help', async t => {
  const f = await fixture(t);
  await f.run('.music set');
  assert.match(f.edits.at(-1).text, /music set/);
  assert.match(f.edits.at(-1).text, /cookie/);
  assert.doesNotMatch(f.edits.at(-1).text, /music clear/);
});
