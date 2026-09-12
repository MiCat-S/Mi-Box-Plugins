'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const esbuild = require(path.join(core, 'node_modules/esbuild'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'speedlink', packageRoot: path.resolve(__dirname, '../speedlink'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('speedlink loads without starting a process and stores only pinned agent configuration', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-speedlink-v2-')));
  const edits = [];
  const host = new PluginHost({storageRoot: root,
    processes: {concurrency: 2, queueCapacity: 8, timeoutMs: 180_000, maxOutputBytes: 2 * 1024 * 1024},
    logger: {info() {}, error() {}}, telegram: {
    async edit(_message, text) { edits.push(text); }, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {},
  }});
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  const definition = create();
  assert.equal(definition.apiVersion, 2);
  assert.deepEqual(Object.keys(definition.commands).sort(), ['sl', 'speedlink']);
  assert.match(definition.renderHelp('.'), /SSH agent/);
  assert.match(definition.renderHelp('.'), /\.sl/);
  assert.equal(definition.resources.processes.timeoutMs, 180_000);
  await host.load(definition);
  await host.dispatchPrimary({id: 1, chatId: '9007199254740993', senderId: '1', outgoing: true,
    text: '.speedlink add tokyo ubuntu@203.0.113.2:2222 SHA256:AbCdEf0123456789+/AbCdEf0123456789abc='});
  assert.match(edits.at(-1), /已添加 tokyo/);
  const stored = JSON.parse(await fs.readFile(path.join(root, 'speedlink/v2-config.json'), 'utf8'));
  assert.deepEqual(stored.servers, [{name: 'tokyo', username: 'ubuntu', host: '203.0.113.2', port: 2222,
    fingerprint: 'SHA256:AbCdEf0123456789+/AbCdEf0123456789abc='}]);
  assert.equal(JSON.stringify(stored).includes('password'), false);
  assert.equal(JSON.stringify(stored).includes('privateKey'), false);
  const settings = definition.settings({});
  assert.equal(settings.getSchema()[0].max, 180);
});

test('speedlink remote runner pins the scanned host key and uses fixed non-interactive SSH arguments', async t => {
  const buildRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-speedlink-runner-'));
  const output = path.join(buildRoot, 'runner.cjs');
  esbuild.buildSync({entryPoints: [path.resolve(__dirname, '../speedlink/v2/runner.ts')], bundle: true,
    platform: 'node', format: 'cjs', outfile: output, external: ['telebox/*']});
  const {runRemote} = require(output);
  const temporary = await fs.mkdtemp(path.join(buildRoot, 'temp-'));
  t.after(() => fs.rm(buildRoot, {recursive: true, force: true}));
  const calls = [];
  const originalSocket = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = '/tmp/mibot-test-agent.sock';
  t.after(() => { if (originalSocket === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = originalSocket; });
  const fingerprint = 'SHA256:AbCdEf0123456789+/AbCdEf0123456789abc=';
  const resultJson = JSON.stringify({server: {id: '1', name: 'fixed', location: 'remote'}, isp: 'ISP',
    ping: {latency: 10}, download: {bandwidth: 1000}, upload: {bandwidth: 500}});
  const context = {signal: new AbortController().signal, files: {async withTemp(operation) {return operation(temporary, context.signal);}},
    processes: {async run(file, args, options) {
      calls.push({file, args, options});
      if (file === '/usr/bin/ssh-keyscan') return {stdout: Buffer.from('[203.0.113.2]:2222 ssh-ed25519 AAAATEST\n')};
      if (file === '/usr/bin/ssh-keygen') return {stdout: Buffer.from(`256 ${fingerprint} host (ED25519)\n`)};
      assert.equal(file, '/usr/bin/ssh');
      const knownOption = args.find(value => value.startsWith('UserKnownHostsFile='));
      assert.ok(knownOption);
      const knownPath = knownOption.slice('UserKnownHostsFile='.length);
      assert.equal((await fs.stat(knownPath)).mode & 0o777, 0o600);
      assert.equal(await fs.readFile(knownPath, 'utf8'), '[203.0.113.2]:2222 ssh-ed25519 AAAATEST\n');
      return {stdout: Buffer.from(resultJson)};
    }}};
  const result = await runRemote(context, {name: 'tokyo', username: 'ubuntu', host: '203.0.113.2', port: 2222, fingerprint}, 45);
  assert.equal(result.server.name, 'fixed');
  assert.deepEqual(calls[0].args, ['-T', '10', '-p', '2222', '203.0.113.2']);
  assert.deepEqual(calls[1].args, ['-E', 'sha256', '-lf', '-']);
  assert.deepEqual(calls[2].args.slice(-7), ['-p', '2222', 'ubuntu@203.0.113.2', 'speedtest', '--accept-license', '--accept-gdpr', '--format=json']);
  assert.ok(calls[2].args.includes('BatchMode=yes'));
  assert.ok(calls[2].args.includes('PasswordAuthentication=no'));
  assert.ok(calls[2].args.includes('StrictHostKeyChecking=yes'));
  assert.equal(calls[2].options.timeoutMs, 45_000);
  assert.deepEqual(calls[2].options.env, {SSH_AUTH_SOCK: '/tmp/mibot-test-agent.sock'});
  const before = calls.length;
  await assert.rejects(runRemote(context, {name: 'tokyo', username: 'ubuntu', host: '203.0.113.2', port: 2222, fingerprint}, 181), /10 到 180/);
  assert.equal(calls.length, before);
});

test('speedlink paginates long server lists', async t => {
  const edits = [], replies = [];
  const servers = Array.from({length: 100}, (_, index) => ({name: `server-${index}-${'x'.repeat(40)}`,
    username: 'ubuntu', host: `host-${index}.example.com`, port: 22,
    fingerprint: 'SHA256:AbCdEf0123456789+/AbCdEf0123456789abc='}));
  let state = {schemaVersion: 1, timeoutSeconds: 180, servers, legacyDatabaseDetected: false, legacyNoticeShown: false};
  const context = {signal: new AbortController().signal, log: {info() {}}, telegram: {
    async edit(_message, text) { edits.push(text); }, async reply(_message, text) { replies.push(text); },
  }, storage: {json() { return {async read() { return structuredClone(state); }, async update(change) {
    state = await change(structuredClone(state)); return structuredClone(state);
  }}; }}};
  const command = create().commands.speedlink.subcommands.list;
  await command.handle({command: 'speedlink', prefix: '.', args: [], subcommand: 'list', subcommands: ['list'],
    message: {id: 1, chatId: '1', outgoing: true, text: '.speedlink list'}}, context);
  assert.equal(edits.length, 1);
  assert.ok(replies.length > 1);
  assert.ok([...edits, ...replies].every(page => page.length <= 3500 && /\d+\/\d+/.test(page)));
});

test('speedlink all stops the active SSH process at the 30 minute total deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-speedlink-all-'));
  t.after(async () => { t.mock.timers.reset(); await fs.rm(root, {recursive: true, force: true}); });
  const fingerprint = 'SHA256:AbCdEf0123456789+/AbCdEf0123456789abc=';
  const state = {schemaVersion: 1, timeoutSeconds: 180, servers: [{name: 'slow', username: 'ubuntu', host: '203.0.113.2', port: 22, fingerprint}],
    legacyDatabaseDetected: false, legacyNoticeShown: false};
  let start;
  const started = new Promise(resolve => { start = resolve; });
  let sshSignal;
  const edits = [];
  const context = {signal: new AbortController().signal, log: {info() {}, error() {}}, telegram: {
    async edit(_message, text) { edits.push(text); }, async reply(_message, text) { edits.push(text); },
  }, storage: {json() { return {async read() { return structuredClone(state); }, async update(change) { return change(structuredClone(state)); }}; }},
  files: {async withTemp(operation) { return operation(root, context.signal); }}, processes: {async run(file, _args, options) {
    if (file === '/usr/bin/ssh-keyscan') return {stdout: Buffer.from('203.0.113.2 ssh-ed25519 AAAATEST\n')};
    if (file === '/usr/bin/ssh-keygen') return {stdout: Buffer.from(`256 ${fingerprint} host (ED25519)\n`)};
    sshSignal = options.signal; start();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}));
  }}};
  const command = create().commands.speedlink.subcommands.all;
  const running = command.handle({command: 'speedlink', prefix: '.', args: [], subcommand: 'all', subcommands: ['all'],
    message: {id: 1, chatId: '1', outgoing: true, text: '.speedlink all'}}, context);
  await started;
  t.mock.timers.tick(30 * 60_000);
  await running;
  assert.equal(sshSignal.aborted, true);
  assert.match(edits.at(-1), /30 分钟总时限/);
});
