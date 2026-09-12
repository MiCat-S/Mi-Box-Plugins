'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const runFile = promisify(execFile);
const plugins = path.resolve(__dirname, '..');
const core = path.resolve(plugins, '../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const esbuild = require(path.join(core, 'node_modules/esbuild'));
const sharp = require(path.join(core, 'node_modules/sharp'));

let createSpeedtest, reportTools, moduleRoot, png;
const processes = {concurrency: 1, queueCapacity: 3, timeoutMs: 180_000, maxOutputBytes: 2 * 1024 * 1024};
const result = JSON.stringify({isp: 'Example ISP', server: {id: 123, name: 'Test & Node', location: 'Shanghai'},
  interface: {externalIp: '203.0.113.9', name: 'test0'}, ping: {latency: 8.5, jitter: 1.2},
  download: {bandwidth: 12500000, bytes: 50000000}, upload: {bandwidth: 6250000, bytes: 25000000},
  timestamp: '2026-09-07T01:02:03.000Z', result: {url: 'https://www.speedtest.net/result/123'}});

test.before(async () => {
  moduleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-speedtest-module-'));
  const built = buildPlugin({id: 'speedtest', packageRoot: path.join(plugins, 'speedtest'), entry: 'v2.ts'});
  createSpeedtest = require(path.join(built.artifactDir, 'index.cjs')).default;
  const reportOutput = path.join(moduleRoot, 'report.cjs');
  esbuild.buildSync({entryPoints: [path.join(plugins, 'speedtest/v2/report.ts')], outfile: reportOutput,
    bundle: true, packages: 'external', alias: {'telebox/sdk': path.join(core, 'dist/v2/sdk.js')}, platform: 'node', format: 'cjs', target: 'node24'});
  reportTools = require(reportOutput);
  png = await sharp({create: {width: 32, height: 20, channels: 4, background: {r: 25, g: 120, b: 220, alpha: 1}}}).png().toBuffer();
});
test.after(async () => { if (moduleRoot) await fs.rm(moduleRoot, {recursive: true, force: true}); });

async function hostFixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'telebox-speedtest-v2-')));
  const edits = [], sent = [], logs = [];
  if (options.setup) await options.setup(root);
  const client = {async sendFile(peer, value) {
    if (options.sendFailure) throw new Error('private-send-token');
    const bytes = await fs.readFile(value.file);
    sent.push({peer, value: {...value, file: path.basename(value.file)}, bytes});
  }};
  const host = new PluginHost({storageRoot: root, processes,
    logger: {info(event, fields) { logs.push({event, fields}); }, error(event, fields) { logs.push({event, fields}); }},
    http: {fetch: options.fetch || (async () => { throw new Error('unexpected external request'); })},
    telegram: {
      async edit(message, text, messageOptions, signal) { signal.throwIfAborted(); edits.push({message, text, options: messageOptions}); },
      async reply() { assert.fail('unexpected reply'); }, async invoke() { assert.fail('unexpected invoke'); },
      async getReply() { return undefined; }, async withClient(operation, signal) { return operation(client, signal); },
    }});
  if (options.load !== false) await host.load(createSpeedtest());
  t.after(async () => { await host.shutdown(3000); await fs.rm(root, {recursive: true, force: true}); });
  let sequence = 0;
  return {root, host, edits, sent, logs, run(text, fields = {}) {
    sequence += 1;
    return host.dispatchPrimary({id: sequence, chatId: fields.chatId || '42', senderId: '42', outgoing: true, text,
      raw: {peerId: {id: 42}, async delete() { fields.deleted && fields.deleted(); }}, ...fields});
  }};
}

async function writeExecutable(file, source) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, source, {mode: 0o700});
  await fs.chmod(file, 0o700);
}

function cliSource(log) {
  return `#!/bin/sh\n[ -n "$HOME" ] && [ -d "$HOME" ] || exit 134\nprintf '<%s>\\n' "$@" >> '${log}'\ncase " $* " in\n  *" --version "*) printf '%s\\n' 'Speedtest by Ookla 1.2.0' ;;\n  *" --servers "*) printf '%s\\n' '{"servers":[{"id":123,"name":"Fixture","location":"Shanghai"}]}' ;;\n  *) printf '%s\\n' '${result}' ;;\nesac\n`;
}

async function archiveWithCli(root, source) {
  const sourceRoot = path.join(root, 'archive-source');
  const archive = path.join(root, 'speedtest.tgz');
  await writeExecutable(path.join(sourceRoot, 'speedtest'), source);
  await runFile('/usr/bin/tar', ['-czf', archive, '-C', sourceRoot, 'speedtest']);
  return fs.readFile(archive);
}

function fetchForResult(image = png) {
  return async (input, init = {}) => {
    const url = new URL(input);
    if ((init.method || 'GET') === 'HEAD' && url.hostname === 'www.speedtest.net') return new Response(null, {status: 204});
    if (url.hostname === 'ip-api.com') return Response.json({as: 'AS64500 Example', country: 'China', countryCode: 'CN'});
    if (url.hostname === 'www.speedtest.net' && url.pathname.endsWith('.png')) {
      return new Response(image, {headers: {'content-type': 'image/png'}});
    }
    throw new Error(`unexpected request ${url}`);
  };
}

test('loads with the declared process budget and preserves both command aliases across unload/reload', async t => {
  const f = await hostFixture(t);
  assert.deepEqual(f.host.listCommands().map(value => value.name), ['speedtest', 'st']);
  assert.equal((await f.host.unload('speedtest', 1000)).completed, true);
  await f.host.load(createSpeedtest());
  assert.equal((await f.host.unload('speedtest', 1000)).completed, true);
  assert.equal(f.host.snapshot().plugins, 0);
});

test('legacy migration is lossless, V2-preferred, and idempotent', async t => {
  const big = '900719925474099312345';
  const f = await hostFixture(t, {setup: async root => {
    const dir = path.join(root, 'speedtest'); await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(path.join(dir, 'config.json'), `{"default_server_id":9,"preferred_type":"photo","legacyBig":${big}}`);
    await fs.writeFile(path.join(dir, 'speedtest.json'), '{"default_server_id":10,"commandOnly":"keep"}');
    await fs.writeFile(path.join(dir, 'v2-config.json'), `{"schemaVersion":1,"default_server_id":77,"preferred_type":"txt","legacyImported":false,"v2Big":${big}}`);
  }});
  await f.run('.speedtest config');
  assert.match(f.edits.at(-1).text, /77/);
  const file = path.join(f.root, 'speedtest/v2-config.json');
  const first = await fs.readFile(file, 'utf8');
  assert.match(first, new RegExp(`"v2Big":${big}`));
  assert.match(first, /"commandOnly":"keep"/);
  assert.equal((await f.host.unload('speedtest', 1000)).completed, true);
  await fs.writeFile(path.join(f.root, 'speedtest/speedtest.json'), '{"default_server_id":99}');
  await f.host.load(createSpeedtest());
  assert.equal(await fs.readFile(file, 'utf8'), first);
});

test('corrupt legacy configuration aborts migration without changing either file', async t => {
  const f = await hostFixture(t, {load: false, setup: async root => {
    const dir = path.join(root, 'speedtest'); await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(path.join(dir, 'config.json'), '{broken private-token');
  }});
  await assert.rejects(f.host.load(createSpeedtest()));
  assert.equal(await fs.readFile(path.join(f.root, 'speedtest/config.json'), 'utf8'), '{broken private-token');
  await assert.rejects(fs.access(path.join(f.root, 'speedtest/v2-config.json')));
});

test('lazy install accepts a bounded response without Content-Length and update truncation preserves the old CLI', async t => {
  let archive, truncated = false;
  const f = await hostFixture(t, {fetch: async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname !== 'install.speedtest.net') return fetchForResult()(input, init);
    if (!archive) throw new Error('archive not ready');
    if (!truncated) return new Response(archive, {status: 200});
    return new Response(archive.subarray(0, Math.max(1, archive.length - 7)), {status: 200,
      headers: {'content-length': String(archive.length)}});
  }});
  const argv = path.join(f.root, 'argv.log');
  archive = await archiveWithCli(f.root, cliSource(argv));
  await f.run('.speedtest fix');
  assert.match(f.edits.at(-1).text, /完成/);
  const managed = path.join(f.root, 'speedtest/speedtest');
  const before = await fs.readFile(managed);
  await f.run('.st type txt');
  await f.run('.st 123');
  const args = await fs.readFile(argv, 'utf8');
  assert.match(args, /<--server-id>\n<123>/);
  const requestsBefore = args;
  await f.run('.speedtest 123;private-token');
  assert.equal(await fs.readFile(argv, 'utf8'), requestsBefore);
  assert.doesNotMatch(JSON.stringify({texts: f.edits.map(edit => edit.text), logs: f.logs}), /private-token/);
  truncated = true;
  await f.run('.speedtest update');
  assert.deepEqual(await fs.readFile(managed), before);
  assert.match(f.edits.at(-1).text, /安装失败/);
});

test('cancelling a queued serial command releases cleanup and never starts the queued process', async t => {
  let f;
  f = await hostFixture(t, {setup: async root => {
    const marker = path.join(root, 'started.log');
    await writeExecutable(path.join(root, 'speedtest/speedtest'), `#!/bin/sh\nprintf x >> '${marker}'\ntrap 'exit 0' TERM\nwhile :; do /bin/sleep 1; done\n`);
  }});
  const first = f.run('.speedtest diagnose', {chatId: '1'}).catch(error => error);
  const marker = path.join(f.root, 'started.log');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fs.readFile(marker)).length) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok((await fs.readFile(marker)).length > 0);
  const second = f.run('.speedtest diagnose', {chatId: '2'}).catch(error => error);
  const report = await f.host.unload('speedtest', 3000);
  await Promise.all([first, second]);
  assert.equal(report.completed, true);
  assert.equal((await fs.readFile(marker, 'utf8')).length, 1);
});

test('report partitioning counts visible UTF-16 units and produces a bounded short caption', () => {
  assert.equal(reportTools.visibleUtf16Length('<b>&amp;😀</b>'), 3);
  const exact = reportTools.reportParts('&amp;'.repeat(1024), JSON.parse(result));
  assert.equal(exact.separateBody, false);
  const long = reportTools.reportParts('&amp;'.repeat(1025), JSON.parse(result));
  assert.equal(long.separateBody, true);
  assert.equal(long.body, '&amp;'.repeat(1025));
  assert.ok(reportTools.visibleUtf16Length(long.caption) < 1024);
});

test('photo, sticker, file, and txt modes deliver real image artifacts with their documented behavior', async t => {
  for (const type of [null, 'photo', 'sticker', 'file', 'txt']) {
    let deleted = 0;
    const f = await hostFixture(t, {fetch: fetchForResult(), setup: async root => {
      const dir = path.join(root, 'speedtest'); await fs.mkdir(dir, {recursive: true});
      await fs.writeFile(path.join(dir, 'v2-config.json'), JSON.stringify({schemaVersion: 1, default_server_id: null, preferred_type: type, legacyImported: true}));
      await writeExecutable(path.join(dir, 'speedtest'), cliSource(path.join(root, `${type}.argv`)));
    }});
    await f.run('.st', {deleted() { deleted += 1; }});
    if (type === 'txt') { assert.equal(f.sent.length, 0); assert.match(f.edits.at(-1).text, /Test &amp; Node/); continue; }
    assert.equal(f.sent.length, 1);
    if (type === 'sticker') {
      const metadata = await sharp(f.sent[0].bytes).metadata();
      assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 512); assert.equal(metadata.height, 512);
      assert.equal(deleted, 0); assert.match(f.edits.at(-1).text, /SPEEDTEST/);
    } else {
      const metadata = await sharp(f.sent[0].bytes).metadata();
      assert.equal(metadata.format, 'png');
      assert.deepEqual(f.sent[0].bytes, png);
      assert.match(f.sent[0].value.caption, /SPEEDTEST/);
      assert.match(f.sent[0].value.caption, /Test &amp; Node/);
      assert.match(f.sent[0].value.caption, /100Mbps/);
      assert.match(f.sent[0].value.caption, /50Mbps/);
      assert.equal(f.sent[0].value.parseMode, 'html');
      assert.equal(f.sent[0].value.forceDocument, type === 'file');
      assert.equal(deleted, 1);
    }
  }
});

test('media failure falls through to text without exposing transport errors', async t => {
  const f = await hostFixture(t, {fetch: fetchForResult(), sendFailure: true, setup: async root => {
    const dir = path.join(root, 'speedtest'); await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(path.join(dir, 'v2-config.json'), JSON.stringify({schemaVersion: 1, default_server_id: null, preferred_type: 'photo', legacyImported: true}));
    await writeExecutable(path.join(dir, 'speedtest'), cliSource(path.join(root, 'fallback.argv')));
  }});
  await f.run('.speedtest');
  assert.match(f.edits.at(-1).text, /SPEEDTEST/);
  assert.doesNotMatch(JSON.stringify({texts: f.edits.map(edit => edit.text), logs: f.logs}), /private-send-token/);
});

test('sticker delivery rejects an external image above the 16M pixel budget', async t => {
  const bomb = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000"><rect width="100%" height="100%"/></svg>');
  const f = await hostFixture(t, {fetch: fetchForResult(bomb), setup: async root => {
    const dir = path.join(root, 'speedtest'); await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(path.join(dir, 'v2-config.json'), JSON.stringify({schemaVersion: 1, default_server_id: null, preferred_type: 'sticker', legacyImported: true}));
    await writeExecutable(path.join(dir, 'speedtest'), cliSource(path.join(root, 'pixel-limit.argv')));
  }});
  await f.run('.speedtest');
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].bytes, bomb);
  assert.equal(f.sent[0].value.forceDocument, false);
  assert.deepEqual(await fs.readdir(path.join(f.root, '.temp/speedtest')), []);
});

for (const externalIp of ['203.0.113.9', '2001:db8::1234']) {
  test(`report omits client address and interface (${externalIp})`, async t => {
    const signal = new AbortController().signal;
    const context = {signal, http: {json: async () => ({})}, tasks: {run: async (_name, operation) => operation(signal)}};
    const sample = JSON.parse(result);
    sample.interface = {externalIp, name: 'private_nic'};
    const html = await reportTools.buildReport(context, sample);
    assert.ok(!html.includes(externalIp));
    assert.doesNotMatch(html, /private_nic|<code>IP<\/code>|IPv4|IPv6/);
    assert.match(html, /服务器/);
    assert.match(html, /下行/);
  });
}

test('report masks IP fields in server and ISP names', async t => {
  const sample = JSON.parse(result); sample.server.name = '38.59.246.201'; sample.isp = '2001:db8::1234';
  const signal = new AbortController().signal;
  const context = {signal, http: {json: async () => ({})}, tasks: {run: async (_name, op) => op(signal)}};
  const report = await reportTools.buildReport(context, sample);
  assert.doesNotMatch(report, /speedtest\.net\/result|38\.59\.246\.201|2001:db8::1234/);
});

test('official image download failure preserves the complete text report', async t => {
  const f = await hostFixture(t, {fetch: async (input, init) => {
    if (new URL(input).pathname.endsWith('.png')) return new Response('unavailable', {status: 503});
    return fetchForResult()(input, init);
  }, setup: async root => {
    await writeExecutable(path.join(root, 'speedtest/speedtest'), cliSource(path.join(root, 'image-failure.argv')));
  }});
  await f.run('.speedtest');
  assert.equal(f.sent.length, 0);
  assert.match(f.edits.at(-1).text, /Test &amp; Node/);
  assert.match(f.edits.at(-1).text, /100Mbps/);
  assert.match(f.edits.at(-1).text, /50Mbps/);
  assert.deepEqual(await fs.readdir(path.join(f.root, '.temp/speedtest')), []);
});
