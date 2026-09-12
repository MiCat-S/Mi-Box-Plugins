'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));

function plugin(id) {
  const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, `../${id}`), entry: 'v2.ts'});
  return require(path.join(artifactDir, 'index.cjs')).default();
}

function memoryStorage(seed = {}) {
  const documents = new Map(Object.entries(seed));
  return {documents, json(file, defaults) {
    if (!documents.has(file)) documents.set(file, structuredClone(defaults));
    return {async read() { return structuredClone(documents.get(file)); }, async update(mutator) {
      const value = await mutator(structuredClone(documents.get(file))); documents.set(file, structuredClone(value)); return structuredClone(value);
    }};
  }};
}

function baseContext(overrides = {}) {
  const edits = [], replies = [];
  const context = {signal: new AbortController().signal, log: {info() {}, error() {}}, storage: memoryStorage(),
    telegram: {async edit(message, text, options) {edits.push({message, text, options});},
      async reply(message, text, options) {replies.push({message, text, options});}, async getReply() {}}, ...overrides};
  return {context, edits, replies};
}

function invocation(command, args = [], extra = {}) {
  return {command, prefix: '.', args, message: {id: 1, chatId: '9', outgoing: true, saved: false,
    text: `.${command} ${args.join(' ')}`.trim(), raw: {peerId: 9, async delete() {}}, ...extra}};
}

test('botmzt serially retrieves a new bot response and sends spoiler media', async () => {
  const sent = [], files = []; let reads = 0;
  const client = {async invoke() {}, async markAsRead() {}, async sendMessage(peer, value) {sent.push({peer, value});},
    async getMessages() {reads += 1; return reads === 1 ? [{id: 10, out: false}] : [{id: 11, out: false, media: {photo: true}}];},
    async sendFile(peer, value) {files.push({peer, value});}};
  const f = baseContext(); f.context.telegram.withClient = operation => operation(client, f.context.signal);
  await plugin('botmzt').commands.rand.handle(invocation('rand'), f.context);
  assert.deepEqual(sent, [{peer: '@FinelyGirlsBot', value: {message: '/rand'}}]);
  assert.equal(files[0].value.spoiler, true);
  assert.deepEqual(files[0].value.file, {photo: true});
});

test('botmzt validates help locally without Telegram bot traffic', async () => {
  const f = baseContext();
  await plugin('botmzt').commands.botmzt.handle(invocation('botmzt'), f.context);
  assert.match(f.edits[0].text, /妹子图片插件/);
});

test('botmzt stops polling when the plugin signal is cancelled', async () => {
  const controller = new AbortController(); let reads = 0;
  const client = {async invoke() {}, async getMessages() {reads += 1; return [];}, async sendMessage() {controller.abort(new Error('stop'));}};
  const f = baseContext({signal: controller.signal});
  f.context.telegram.withClient = operation => operation(client, controller.signal);
  await plugin('botmzt').commands.rand.handle(invocation('rand'), f.context);
  assert.equal(reads, 1);
  assert.equal(f.edits.length, 1);
});

test('bs migrates legacy state, adds targets, and forwards replied messages', async () => {
  const storage = memoryStorage({'config.json': {seq: 'bad', mode: 'sequence', targets: [], unknown: 'keep'}});
  const calls = [];
  const entity = {id: 77n, title: 'Target'};
  const client = {async getEntity() {return entity;}, async getInputEntity() {return entity;},
    async getMessages(_peer, {ids}) {return [{id: ids[0]}];}, async invoke(request) {calls.push(request); return {updates: [{message: {className: 'Message', id: 5}}]};}};
  const f = baseContext({storage}); f.context.telegram.withClient = operation => operation(client, f.context.signal);
  f.context.telegram.getReply = async () => ({id: 4, chatId: '9', raw: {id: 4, peerId: 9}});
  const definition = plugin('bs'); await definition.setup(f.context);
  await definition.commands.bs.handle(invocation('bs', ['add', '@target']), f.context);
  await definition.commands.bs.handle(invocation('bs', ['1']), f.context);
  const state = storage.documents.get('config.json');
  assert.equal(state.schemaVersion, 1); assert.equal(state.unknown, 'keep'); assert.equal(state.targets[0].chatId, '77');
  assert.equal(calls.length, 1); assert.match(f.edits.at(-1).text, /已保送至/);
});

test('cosplay accepts only bounded same-domain media and streams temp files to Telegram', async () => {
  const listing = '<a href="https://cosplaytele.com/set-one/">set</a>';
  const detail = '<figure class="gallery-item"><img src="https://img.cosplaytele.com/a.jpg"></figure>';
  const files = [];
  const f = baseContext();
  f.context.http = {async withResponse(url, init, consume, options) {
    const isImage = init.headers.Accept === 'image/*';
    const body = isImage ? Buffer.from('image') : String(url).includes('/set-one/') ? detail : listing;
    const type = isImage ? 'image/jpeg' : 'text/html';
    assert.deepEqual(options.redirects, {allowedHosts: [new URL(url).hostname], maxRedirects: 3});
    return consume(new Response(body, {status: 200, headers: {'content-type': type}}), f.context.signal);
  }};
  f.context.files = {async withTemp(use) {const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-v2-')); try {return await use(directory, f.context.signal);} finally {await fs.rm(directory, {recursive: true, force: true});}}};
  f.context.telegram.withClient = operation => operation({async sendFile(peer, value) {files.push({peer, value});}}, f.context.signal);
  await plugin('cosplay').commands.cos.handle(invocation('cos', ['1']), f.context);
  assert.equal(files.length, 1); assert.equal(files[0].value.spoiler, true); assert.match(files[0].value.caption, /^套图链接: https:\/\/cosplaytele\.com\//);
});

test('cosplay rejects invalid counts before network access', async () => {
  const f = baseContext(); let requests = 0; f.context.http = {async text() {requests += 1;}};
  await plugin('cosplay').commands.cosplay.handle(invocation('cosplay', ['11']), f.context);
  assert.equal(requests, 0); assert.match(f.edits[0].text, /1 到 10/);
});

test('cosplay honors cancellation without a success placeholder', async () => {
  const controller = new AbortController();
  const f = baseContext({signal: controller.signal}); let files = 0;
  f.context.http = {async withResponse() {controller.abort(new Error('stop')); throw new Error('provider details');}};
  f.context.files = {async withTemp() {throw new Error('must not create files');}};
  f.context.telegram.withClient = async () => {files += 1;};
  await plugin('cosplay').commands.cos.handle(invocation('cos', ['1']), f.context);
  assert.equal(files, 0);
  assert.equal(f.edits.length, 1);
  assert.equal(f.edits[0].text, '正在从随机套图中获取 1 张图片…');
});

test('cosplay reports provider failure with a stable message', async () => {
  const f = baseContext();
  f.context.http = {async withResponse() {throw new Error('private provider detail');}};
  await plugin('cosplay').commands.cos.handle(invocation('cos', ['1']), f.context);
  assert.equal(f.edits.at(-1).text, '获取 Cosplay 图片失败，请稍后重试');
  assert.ok(f.edits.every(value => !value.text.includes('private provider detail')));
});

test('git_PR restricts token setup while allowing authenticated group reads', async () => {
  const storage = memoryStorage(); const requests = [];
  const f = baseContext({storage});
  f.context.http = {async withResponse(url, init, consume, options) {
    requests.push({url: String(url), init, options});
    return consume(new Response(JSON.stringify([{full_name: 'o/r', permissions: {push: true}}]), {status: 200}), f.context.signal);
  }};
  const definition = plugin('git_PR'); await definition.setup(f.context);
  await definition.commands.git.handle(invocation('git', ['login', 'e', 'u', 'secret'], {saved: false}), f.context);
  assert.equal(storage.documents.get('config.json').git_token, '');
  await definition.commands.git.handle(invocation('git', ['login', 'e', 'u', 'secret'], {saved: true}), f.context);
  await definition.commands.git.handle(invocation('git', ['repos'], {saved: false, chatId: '-10099'}), f.context);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret');
  assert.deepEqual(requests[0].options.redirects, {allowedHosts: ['api.github.com'], maxRedirects: 2});
  assert.equal(requests[0].options.signal, f.context.signal);
  assert.match(f.edits.at(-1).text, /o\/r/); assert.ok(f.edits.every(value => !value.text.includes('secret')));
});

test('git_PR mergeall reports partial success and authentication failures without leaking token', async () => {
  const storage = memoryStorage({'config.json': {schemaVersion: 1, git_email: '', git_username: '', git_token: 'secret', git_api_base_url: 'https://api.github.com'}});
  const f = baseContext({storage});
  f.context.http = {async withResponse(url, init, consume) {
    const target = String(url); let response;
    if (init.method === 'GET') response = new Response(JSON.stringify([{number: 2}, {number: 1}]), {status: 200});
    else if (target.includes('/1/merge')) response = new Response(JSON.stringify({merged: true}), {status: 200});
    else response = new Response(JSON.stringify({message: 'blocked secret'}), {status: 422});
    return consume(response, f.context.signal);
  }};
  await plugin('git_PR').commands.git.handle(invocation('git', ['mergeall', 'o/r'], {saved: true}), f.context);
  assert.match(f.edits.at(-1).text, /成功：1/); assert.match(f.edits.at(-1).text, /失败：1/);
  assert.ok(f.edits.every(value => !value.text.includes('secret')));
});

test('git_PR returns a stable authentication error and never exposes provider details', async () => {
  const storage = memoryStorage({'config.json': {schemaVersion: 1, git_email: '', git_username: '', git_token: 'secret', git_api_base_url: 'https://api.github.com'}});
  const f = baseContext({storage});
  f.context.http = {async withResponse(_url, _init, consume) {
    return consume(new Response(JSON.stringify({message: 'bad secret'}), {status: 401}), f.context.signal);
  }};
  await plugin('git_PR').commands.git.handle(invocation('git', ['repos'], {saved: false, chatId: '-10099'}), f.context);
  assert.match(f.edits.at(-1).text, /认证失败或权限不足/);
  assert.doesNotMatch(f.edits.at(-1).text, /bad secret|secret/);
});
