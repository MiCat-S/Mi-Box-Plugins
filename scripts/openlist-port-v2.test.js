'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'openlist', packageRoot: path.resolve(__dirname, '../openlist'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('openlist media login and upload follow the persisted service port', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openlist-port-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  let data = {schemaVersion: 1, username: 'admin', password: 'secret', defaultPath: '/media', port: 5255, legacyImported: true};
  const urls = [], edits = [];
  const signal = new AbortController().signal;
  const context = {signal, storage: {json: () => ({async read() {return structuredClone(data);}, async update(fn) {data = await fn(structuredClone(data)); return data;}})},
    telegram: {async edit(_message, text) {edits.push(text);}, async getReply() {return {id: 3, raw: {media: {}, file: {name: 'photo.jpg'}}};},
      async withClient(operation) {return operation({async *iterDownload() {yield Buffer.from('image-data');}}, signal);}},
    files: {async withTemp(operation) {const dir = await fs.mkdtemp(path.join(root, 'job-')); try {return await operation(dir, signal);} finally {await fs.rm(dir, {recursive: true, force: true});}}},
    http: {async withResponse(url, init, consumer) {
      urls.push(String(url));
      const body = String(url).endsWith('/api/auth/login') ? {code: 200, data: {token: 'token'}} : {code: 200, data: {}};
      return consumer(new Response(JSON.stringify(body), {status: 200}), signal);
    }}, log: {error() {}}, processes: {async run() {throw new Error('no process expected');}}};
  await create().commands.op.handle({command: 'op', prefix: '.', args: ['save'], message: {id: 5, chatId: '1', replyToId: 3, text: '.op save', outgoing: true}}, context);
  assert.deepEqual(urls, ['http://127.0.0.1:5255/api/auth/login', 'http://127.0.0.1:5255/api/fs/put']);
  assert.match(edits.at(-1), /文件已上传/);
});

test('openlist pins v4.2.2 official digests and requires exactly one archive member', async () => {
  const source = await fs.readFile(path.resolve(__dirname, '../openlist/v2.ts'), 'utf8');
  const expected = {
    amd64: '9a08dd3c51caffcfd647dee60e6dd288aba769e703b0235fe02424ee7733a0d9',
    arm64: 'de8cf8b9a5105635dee3d893e5d1e70948f89c404a34d18223ddbd392e43ec23',
    loong64: '9c10070a534f71fe2114eed41f95613abffa784c9771aca42f0c46924b5430e6',
    s390x: 'a1afe5eed6c7cadbf35dc332dd2811261fa46ad974cba4947339798b40a91a30',
  };
  assert.match(source, /const VERSION="v4\.2\.2"/);
  for (const [architecture, digest] of Object.entries(expected)) {
    assert.ok(source.includes(`openlist-linux-musl-${architecture}.tar.gz`));
    assert.ok(source.includes(`sha256:"${digest}"`));
  }
  assert.match(source, /members\.length!==1\|\|members\[0\]!=="openlist"/);
  assert.match(source, /"--no-same-owner","--no-same-permissions","--","openlist"/);
});

test('openlist rejects a mismatched release digest before invoking tar or systemctl', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openlist-digest-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  let data = {schemaVersion: 1, username: '', password: '', defaultPath: '', port: 5244, legacyImported: true};
  const edits = [], urls = [], processes = [];
  const signal = new AbortController().signal;
  const context = {signal, log: {error() {}}, storage: {json: () => ({async read() {return structuredClone(data);},
    async update(fn) {data = await fn(structuredClone(data)); return data;}})}, telegram: {async edit(_message, text) {edits.push(text);}},
    files: {async withTemp(operation) {const directory = await fs.mkdtemp(path.join(root, 'job-')); try {return await operation(directory, signal);} finally {await fs.rm(directory, {recursive: true, force: true});}}},
    http: {async withResponse(url, _init, consumer) {urls.push(String(url)); return consumer(new Response('not-an-official-archive'), signal);}},
    processes: {async run(command, args) {processes.push({command, args}); throw new Error('process must not run before digest validation');}}};
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {...descriptor, value: 'linux'});
  try {
    await create().commands.op.handle({command: 'op', prefix: '.', args: ['install'], message: {id: 1, chatId: '1', text: '.op install', outgoing: true}}, context);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
  assert.equal(urls.length, 1);
  assert.match(urls[0], /OpenList\/releases\/download\/v4\.2\.2\/openlist-linux-musl-(?:amd64|arm64|loong64|s390x)\.tar\.gz$/);
  assert.deepEqual(processes, []);
  assert.match(edits.at(-1), /SHA-256/);
});

test('openlist rejects unsafe restore names before filesystem-changing processes', async () => {
  const edits = [], processes = [];
  const signal = new AbortController().signal;
  const context = {signal, log: {error() {}}, telegram: {async edit(_message, text) {edits.push(text);}},
    processes: {async run(command, args) {processes.push({command, args}); return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};}}};
  await create().commands.op.handle({command: 'op', prefix: '.', args: ['restore', '../backup_20260101_000000'],
    message: {id: 1, chatId: '1', text: '.op restore ../backup_20260101_000000', outgoing: true}}, context);
  assert.deepEqual(processes, []);
  assert.match(edits.at(-1), /有效的 OpenList 备份名/);
});

test('openlist reports a backup rollback failure instead of hiding partial cleanup', async () => {
  const edits = [], calls = [];
  const signal = new AbortController().signal;
  const context = {signal, log: {error() {}}, telegram: {async edit(_message, text) {edits.push(text);}}, processes: {async run(command, args) {
    calls.push({command, args});
    if (command === '/bin/date') return {stdout: Buffer.from('20260912_120000_123\n'), stderr: Buffer.alloc(0)};
    if (command === '/bin/cp') throw new Error('copy failed');
    if (command === '/bin/rm') throw new Error('cleanup failed');
    return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
  }}};
  await create().commands.op.handle({command: 'op', prefix: '.', args: ['backup'],
    message: {id: 1, chatId: '1', text: '.op backup', outgoing: true}}, context);
  assert.deepEqual(calls[2].args, ['/opt/openlist_backups/backup_20260912_120000_123']);
  assert.deepEqual(calls.at(-1).args, ['-rf', '/opt/openlist_backups/backup_20260912_120000_123']);
  assert.match(edits.at(-1), /复制失败|回滚未完成/);
  assert.match(edits.at(-1), /回滚未完成/);
});
