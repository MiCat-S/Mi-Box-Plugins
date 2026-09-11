'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const ids = ['kkp', 'convert', 't', 'eatgif'];
const factories = Object.fromEntries(ids.map(id => {
  const built = buildPlugin({id, packageRoot: path.resolve(__dirname, `../${id}`), entry: 'v2.ts'});
  return [id, require(path.join(built.artifactDir, 'index.cjs')).default];
}));

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {json(file, defaults) { if (!values.has(file)) values.set(file, structuredClone(defaults)); return {
    async read() { return structuredClone(values.get(file)); },
    async update(change) { const next = change(structuredClone(values.get(file))); values.set(file, structuredClone(next)); return structuredClone(next); },
  };}, sqlite() { return {async read() { throw new Error('missing legacy database'); }}; }, values};
}
function tempFiles() {
  return {dataPath(name = '') { return path.join(os.tmpdir(), 'mibot-test-data', name); },
    async dataFile(name) { const target = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-data-')), name); await fs.mkdir(path.dirname(target), {recursive: true}); return target; },
    async withTemp(use) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-media-')); const signal = new AbortController().signal;
      try { return await use(directory, signal); } finally { await fs.rm(directory, {recursive: true, force: true}); }} };
}
function base(overrides = {}) {
  const edits = [], sends = [], controller = new AbortController();
  const storage = overrides.storage ?? memoryStorage();
  const client = overrides.client ?? {};
  const context = {signal: controller.signal, tasks: {}, commands: {parse() {}}, jobs: {}, services: overrides.services ?? {}, storage,
    files: overrides.files ?? tempFiles(), log: {info() {}, error() {}},
    http: overrides.http ?? {async json() { throw new Error('offline'); }, async withResponse() { throw new Error('offline'); }},
    processes: overrides.processes ?? {async run() { throw new Error('offline'); }},
    telegram: {async edit(message, text, options) { edits.push({message, text, options}); }, async reply() {}, async invoke() {},
      async getReply() { return overrides.reply; }, async withClient(operation) { return operation(client, controller.signal); }}};
  return {context, edits, sends, storage, client, controller};
}
function invoke(factory, command, text, fixture, message = {}) {
  return factory().commands[command].handle({command, prefix: '.', args: text.trim().split(/\s+/).slice(1),
    message: {id: 1, chatId: '10', senderId: '7', outgoing: true, text, raw: {peerId: 10, async delete() {}}, ...message}}, fixture.context);
}

test('kkp serializes bot requests and associates each new video with one caller', async () => {
  let active = 0, maximum = 0, sequence = 0;
  const files = [];
  const client = {async getMessages(peer, options) {
    if (options.limit === 1) return [{id: sequence * 10}];
    return [{id: sequence * 10 + 1, out: false, media: {document: sequence}, document: {mimeType: 'video/mp4'}, message: `video ${sequence}`}];
  }, async sendMessage(peer, value) { if (value.message === '随机色色') {active += 1; maximum = Math.max(maximum, active); sequence += 1;} },
  async sendFile(peer, value) {files.push(value.file.document); active -= 1;}, async markAsRead() {}};
  const f = base({client}); const plugin = factories.kkp(); const run = id => plugin.commands.kkp.handle({command: 'kkp', prefix: '.', args: [],
    message: {id, chatId: String(id), outgoing: true, text: '.kkp', raw: {peerId: id, async delete() {}}}}, f.context);
  await Promise.all([run(1), run(2)]);
  assert.equal(maximum, 1); assert.deepEqual(files, [1, 2]);
});

test('kkp cancels pending bot polling during unload', async () => {
  const f = base({client: {async getMessages() { return []; }, async sendMessage() {}}});
  const pending = factories.kkp().commands.kkp.handle({command: 'kkp', prefix: '.', args: [],
    message: {id: 1, chatId: '1', outgoing: true, text: '.kkp', raw: {peerId: 1}}}, f.context);
  await new Promise(resolve => setTimeout(resolve, 10)); f.controller.abort();
  await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('cancel timeout')), 200))]);
});

test('convert streams Telegram media through bounded FFmpeg and sends MP3', async () => {
  const calls = [], sent = [];
  const replyRaw = {media: {}, document: {attributes: [{fileName: '演唱会.mp4'}]}};
  const client = {async downloadMedia(media, options) { await fs.writeFile(options.outputFile, Buffer.alloc(1024)); },
    async sendFile(peer, options) { sent.push({peer, options}); }};
  const processes = {async run(command, args, options) { calls.push({command, args, options});
    if (command.includes('ffprobe')) return {stdout: Buffer.from('12.4'), stderr: Buffer.alloc(0), exitCode: 0};
    await fs.writeFile(args.at(-1), Buffer.from('mp3')); return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0}; }};
  const f = base({client, processes, reply: {id: 9, raw: replyRaw}});
  await invoke(factories.convert, 'convert', '.convert 新 名称', f, {replyToId: 9});
  assert.equal(calls[0].command.startsWith('/'), true); assert.equal(calls[0].options.timeoutMs <= 180000, true);
  assert.equal(sent.length, 1); assert.equal(sent[0].options.replyTo, 9); assert.equal(sent[0].options.file.endsWith('.mp3'), true);
});

test('convert AI mode uses the unified search service for metadata', async () => {
  const serviceCalls = [], sent = [];
  const replyRaw = {media: {}, document: {attributes: [{fileName: '现场版.mp4'}]}};
  const client = {async downloadMedia(_media, options) { await fs.writeFile(options.outputFile, Buffer.alloc(1024)); },
    async sendFile(peer, options) { sent.push({peer, options}); }};
  const processes = {async run(command, args) {
    if (command.includes('ffprobe')) return {stdout: Buffer.from('8.2'), stderr: Buffer.alloc(0), exitCode: 0};
    await fs.writeFile(args.at(-1), Buffer.from('mp3')); return {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0};
  }};
  const services = {available(plugin, service) { return plugin === 'ai' && service === 'search'; },
    async call(plugin, service, input) { serviceCalls.push({plugin, service, input});
      return {text: '歌曲名：稻香\n歌手：周杰伦\n专辑：我很忙'}; }};
  const f = base({client, processes, services, reply: {id: 9, raw: replyRaw},
    http: {async json() { return {resultCount: 0, results: []}; }, async withResponse() { throw new Error('unexpected download'); }}});
  const subcommand = factories.convert().commands.convert.subcommands.u;
  await subcommand.handle({command: 'convert', prefix: '.', args: ['稻香'], subcommands: ['u'],
    message: {id: 1, chatId: '10', outgoing: true, text: '.convert u 稻香', replyToId: 9,
      raw: {peerId: 10, async delete() {}}}}, f.context);
  assert.equal(serviceCalls.length, 1);
  assert.deepEqual({plugin: serviceCalls[0].plugin, service: serviceCalls[0].service}, {plugin: 'ai', service: 'search'});
  assert.match(serviceCalls[0].input.text, /稻香/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.attributes[0].title, '稻香');
  assert.equal(sent[0].options.attributes[0].performer, '周杰伦');
});

test('convert delegates AI provider settings and does not retry helper exit failures', async () => {
  const f = base();
  await invoke(factories.convert, 'convert', '.convert apikey private-key', f);
  assert.match(f.edits.at(-1).text, /ai 插件统一管理/);
  await invoke(factories.convert, 'convert', '.convert apikey private-key', f, {saved: true});
  assert.equal(f.edits.some(entry => entry.text.includes('private-key')), false);
  assert.equal(f.storage.values.has('config.json'), false);
  const source = await fs.readFile(path.resolve(__dirname, '../convert/v2.ts'), 'utf8');
  assert.match(source, /code !== "SPAWN_FAILED"\) throw error/);
});

test('t migrates existing JSON roles, restricts keys, and streams Fish output into a scoped voice conversion', async () => {
  const storage = memoryStorage({'tts_data.json': {users: {}, roles: {旧角色: 'legacy-id'}, covers: {}}});
  const f = base({storage});
  await invoke(factories.t, 'tk', '.tk secret', f); assert.match(f.edits.at(-1).text, /收藏夹/);
  await invoke(factories.t, 'tk', '.tk secret', f, {saved: true});
  const stored = storage.values.get('tts_data.json'); assert.equal(stored.roles.旧角色, 'legacy-id'); assert.equal(stored.schemaVersion, 1);
  const calls = [], sent = [];
  f.context.http.withResponse = async (url, init, consume) => consume(new Response(Buffer.from('mp3'), {status: 200}), f.context.signal);
  f.context.processes.run = async (command, args, options) => { calls.push({command, args, options}); await fs.writeFile(args.at(-1), 'ogg'); return {stdout: Buffer.alloc(0)}; };
  f.context.telegram.withClient = async operation => operation({async sendFile(peer, value) {sent.push({peer, value});}}, f.context.signal);
  await factories.t().commands.t.handle({command: 't', prefix: '.', args: ['你好', '👋'], message: {id: 2, chatId: '10', senderId: '7', outgoing: true,
    text: '.t 你好 👋', raw: {peerId: 10, async delete() {}}}}, f.context);
  assert.equal(calls[0].command.startsWith('/'), true); assert.equal(sent[0].value.voiceNote, true);
});

test('eatgif validates and renders the remote catalog without loading native media dependencies', async () => {
  const f = base({http: {async withResponse(url, init, consume) {
    const payload = JSON.stringify({wave: {url: 'wave.json', desc: '<挥手>'}});
    return consume(new Response(payload, {status: 200}), f.context.signal);
  }}});
  await invoke(factories.eatgif, 'eatgif', '.eatgif list', f);
  assert.match(f.edits.at(-1).text, /&lt;挥手&gt;/); assert.doesNotMatch(f.edits.at(-1).text, /<挥手>/);
  assert.deepEqual(factories.eatgif().resources.processes, {concurrency: 1, queueCapacity: 1, timeoutMs: 180000, maxOutputBytes: 256 * 1024});
});

test('all four artifacts load, unload and reload through the real PluginHost', async () => {
  const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-host-media-')));
  const unavailable = async () => { throw new Error('offline'); };
  const host = new PluginHost({storageRoot: path.join(root, 'assets'), tempRoot: path.join(root, 'temp'), logger: {info() {}, error() {}},
    telegram: {edit: unavailable, reply: unavailable, invoke: unavailable, getReply: unavailable, withClient: unavailable},
    processes: {concurrency: 2, queueCapacity: 16, timeoutMs: 180000, maxOutputBytes: 2 * 1024 * 1024}});
  try {
    for (const id of ids) {
      const definition = factories[id](); host.preflight(definition); await host.load(definition);
      assert.equal((await host.unload(id, 5000)).completed, true); await host.load(factories[id]());
      assert.equal((await host.unload(id, 5000)).completed, true);
    }
  } finally { assert.equal((await host.shutdown(5000)).completed, true); await fs.rm(root, {recursive: true, force: true}); }
});

test('media plugins declare budgets within the production host cap', () => {
  for (const id of ['convert', 't', 'eatgif']) {
    const limits = factories[id]().resources.processes;
    assert.equal(limits.timeoutMs <= 180000, true); assert.equal(limits.maxOutputBytes <= 2 * 1024 * 1024, true);
  }
});
