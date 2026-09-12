'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {SqliteStore} = require(path.join(core, 'dist/v2/sqlite.js'));

function factory() {
  const {artifactDir} = buildPlugin({id: 'yt-dlp', packageRoot: path.resolve(__dirname, '../yt-dlp'), entry: 'v2.ts'});
  return require(path.join(artifactDir, 'index.cjs')).default;
}

async function fakeYtDlp(directory, mode = 'normal') {
  const script = path.join(directory, `fake-yt-dlp-${mode}`);
  const source = [
    '#!/bin/sh',
    ': > "$0.args"',
    'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$0.args"; done',
    'probe=0',
    'output=\'\'',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --dump-single-json) probe=1 ;;',
    '    -P) shift; output="$1" ;;',
    '  esac',
    '  shift',
    'done',
    'if [ "$probe" -eq 1 ]; then',
    '  printf \'%s\\n\' \'{"id":"abcdefghijk","title":"Fallback Title","uploader":"Fallback Artist","duration":95,"filesize_approx":4096}\'',
    '  exit 0',
    'fi',
    ': > "$0.started"',
    ...(mode === 'slow' ? ['sleep 30'] : []),
    ...(mode === 'oversize' ? [
      'dd if=/dev/zero of="$output/track.part" bs=1048576 count=15 2>/dev/null',
      ': > "$0.oversized"',
      'sleep 30',
    ] : []),
    'printf \'yt-audio\' > "$output/track.mp3"',
    'printf \'yt-cover\' > "$output/track.jpg"',
  ].join('\n');
  await fs.writeFile(script, source, {mode: 0o700});
  await fs.chmod(script, 0o700);
  return script;
}

async function createHost(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-yt-dlp-v2-')));
  if (options.seed) await options.seed(root);
  const executable = await fakeYtDlp(root, options.mode);
  const edits = [], sent = [], aiCalls = [], imports = [], logs = [];
  let uploadedPath, deleted = 0;
  const host = new PluginHost({storageRoot: root, tempRoot: path.join(root, 'temp'),
    logger: {info(label){logs.push(label);}, error(label){logs.push(label);}},
    processes: {concurrency: 2, queueCapacity: 8, timeoutMs: 180000, maxOutputBytes: 2 * 1024 * 1024},
    telegram: {async edit(message,text,editOptions){edits.push({message,text,options:editOptions});},
      async reply(){assert.fail('unexpected reply');}, async invoke(){assert.fail('unexpected invoke');}, async getReply(){return undefined;},
      async withClient(operation, signal){return operation({async sendFile(_peer, sendOptions){
        uploadedPath = sendOptions.file; sent.push({...sendOptions, bytes: await fs.readFile(sendOptions.file)});
      }}, signal);}}});
  await host.load({apiVersion: 1, id: 'ai', description: 'test ai', commands: {}, services: {
    chat: {description: 'test', async handle(input){aiCalls.push(input); return '歌曲名: 稻香\n歌手: 周杰伦\n专辑: 魔杰座';}},
    import_provider: {description: 'test', async handle(input){imports.push(input); return {tag: 'yt-imported'};}},
  }});
  await host.load(factory()({locateTools: async () => ({ytDlp: executable, ffmpeg: '/usr/bin/true'})}));
  t.after(async () => {
    if (host.pluginState('yt-dlp')) await host.unload('yt-dlp', 2000);
    assert.equal((await host.shutdown(2000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  const run = text => host.dispatchPrimary({id: 9, chatId: '-1009876543210123456', senderId: '42', outgoing: true,
    chatType: 'supergroup', text, raw: {peerId: {className: 'PeerChannel'}, async delete(){
      deleted += 1; if (options.deleteFails) throw new Error('delete denied');
    }}});
  return {root, executable, host, edits, sent, aiCalls, imports, logs, run,
    uploadedPath: () => uploadedPath, deleted: () => deleted};
}

async function waitFor(file) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {await fs.access(file); return;} catch {await new Promise(resolve => setTimeout(resolve, 10));}
  }
  await fs.access(file);
}

test('yt downloads one bounded MP3 through ai.chat and never invokes a runtime updater', async t => {
  const f = await createHost(t, {deleteFails: true});
  await f.run('.yt 稻香');
  assert.equal(f.aiCalls.length, 1);
  assert.equal(f.aiCalls[0].text, '稻香');
  assert.equal(Object.hasOwn(f.aiCalls[0], 'video'), false);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].bytes, Buffer.from('yt-audio'));
  assert.equal(f.sent[0].attributes[0].title, '稻香');
  assert.equal(f.sent[0].attributes[0].performer, '周杰伦');
  await assert.rejects(fs.stat(f.uploadedPath()), {code: 'ENOENT'});
  const before = await fs.readFile(`${f.executable}.args`, 'utf8');
  assert.match(before, /--ignore-config/);
  assert.match(before, /--no-playlist/);
  assert.match(before, /--match-filter/);
  assert.match(before, /--format\nbestaudio\/best/);
  assert.doesNotMatch(before, /(?:^|\n)(?:-U|--update)(?:\n|$)/);
  assert.equal(f.deleted(), 1);
  assert.equal(f.logs.includes('yt_dlp_receipt_cleanup_failed'), true);
  assert.equal(f.edits.some(item => /下载失败/.test(item.text)), false);
  await f.run('.yt update');
  assert.match(f.edits.at(-1).text, /不会下载或自更新/);
  assert.equal(await fs.readFile(`${f.executable}.args`, 'utf8'), before);
  await f.run('.yt apikey should-not-be-stored');
  assert.match(f.edits.at(-1).text, /ai 插件统一管理/);
});

test('yt unload cancels and drains an in-flight helper process', async t => {
  const f = await createHost(t, {mode: 'slow'});
  const pending = f.run('.yt slow');
  await waitFor(`${f.executable}.started`);
  const unloading = f.host.unload('yt-dlp', 2000);
  const [dispatch, report] = await Promise.allSettled([pending, unloading]);
  assert.equal(report.status, 'fulfilled');
  assert.equal(report.value.completed, true);
  assert.ok(['fulfilled', 'rejected'].includes(dispatch.status));
  assert.equal(f.sent.length, 0);
});

test('yt cancels a helper that exceeds the temporary directory byte budget and uploads nothing', async t => {
  const f = await createHost(t, {mode: 'oversize'});
  await f.host.patchSettings('yt-dlp', {maxUploadBytes: 1024 * 1024});
  await f.run('.yt oversized');
  await waitFor(`${f.executable}.oversized`);
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1).text, /下载失败/);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'temp', 'yt-dlp')), []);
});

test('yt migrates its declared legacy Gemini SQLite config and scrubs the key before marking success', async t => {
  const f = await createHost(t, {seed: async root => {
    const legacy = new SqliteStore(path.join(root, 'ytdlp_gemini_config.db'));
    await legacy.transaction(db => {
      db.exec('CREATE TABLE config(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const insert = db.prepare('INSERT INTO config(key, value) VALUES (?, ?)');
      insert.run('ytdlp_gemini_api_key', 'legacy-yt-key');
      insert.run('ytdlp_gemini_base_url', 'https://generativelanguage.googleapis.com');
      insert.run('ytdlp_gemini_model', 'gemini-2.0-flash');
    });
    await legacy.close();
  }});
  assert.equal(f.imports.length, 1);
  assert.equal(f.imports[0].key, 'legacy-yt-key');
  assert.equal(f.imports[0].url, 'https://generativelanguage.googleapis.com/v1beta');
  const legacy = new SqliteStore(path.join(f.root, 'ytdlp_gemini_config.db'));
  assert.equal(await legacy.read(db => db.prepare('SELECT value FROM config WHERE key = ?').pluck().get('ytdlp_gemini_api_key')), '');
  await legacy.close();
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'yt-dlp', 'config.json'), 'utf8'));
  assert.equal(state.legacyAiMigrated, true);
  assert.equal(state.importedAiTag, 'yt-imported');
});

test('yt download service rejects malformed cross-plugin input before starting a process', async t => {
  const f = await createHost(t);
  let context;
  await f.host.load({apiVersion: 1, id: 'test-consumer', description: 'test consumer', commands: {}, setup(value){context = value;}});
  const message = {id: 1, chatId: '-1009007199254740993', senderId: '1', outgoing: true, text: '.consumer',
    raw: {peerId: {className: 'PeerChannel'}}};
  const options = {cookie: '', proxy: '', quality: '', maxDurationSeconds: 900, maxUploadBytes: 1024 * 1024};
  await assert.rejects(context.services.call('yt-dlp', 'download_mp3', {
    query: 'x'.repeat(301), message, options,
  }, context.signal), /INVALID_SERVICE_INPUT/);
  await assert.rejects(context.services.call('yt-dlp', 'download_mp3', {
    query: 'valid query', message, options: {...options, quality: 'lossless'},
  }, context.signal), /INVALID_SERVICE_INPUT/);
  await assert.rejects(fs.stat(`${f.executable}.args`), {code: 'ENOENT'});
});
