'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const create = require(path.join(buildPlugin({id: 'deepwiki', packageRoot: path.resolve(__dirname, '../deepwiki'), entry: 'v2.ts'}).artifactDir, 'index.cjs')).default;
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

async function fixture(t, fetch, {reply, initial, failEditAt, failReplyAt} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deepwiki-compat-'))), edits = [], replies = [], requests = [], logs = [];
  let editCalls = 0, replyCalls = 0;
  if (initial) {await fs.mkdir(path.join(root, 'deepwiki'), {recursive: true}); await fs.writeFile(path.join(root, 'deepwiki/data.json'), JSON.stringify(initial));}
  const host = new PluginHost({storageRoot: root, logger: {info(event, fields) {logs.push({event, fields});}, error() {}}, http: {fetch: async (url, init) => {
    requests.push({url: String(url), body: init.body && JSON.parse(init.body)}); return fetch(url, init);
  }}, telegram: {async edit(_message, text) {editCalls++; if (editCalls === failEditAt) throw new Error('edit failed'); edits.push(text);}, async reply(_message, text) {replyCalls++; if (replyCalls === failReplyAt) throw new Error('reply failed'); replies.push(text);},
    async invoke() {}, async getReply() {return reply;}, async withClient() {throw new Error('unexpected client');}}});
  await host.load(create());
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  let id = 0;
  const run = (text, extra = {}) => host.dispatchPrimary({id: ++id, chatId: '100', senderId: '1', outgoing: true, text, ...extra});
  return {host, edits, replies, requests, logs, run};
}

function mcp(answer, inspect) {
  return async (_url, init) => {const body = JSON.parse(init.body); inspect?.(body);
    if (body.method === 'initialize') return new Response('{}', {headers: {'mcp-session-id': 'local'}});
    if (body.method === 'notifications/initialized') return new Response('', {status: 202});
    return Response.json({result: {content: [{type: 'text', text: answer}]}});
  };
}

test('DEEPWIKI-COMPAT-01 a replied question can select a tag without extra inline text', async t => {
  const calls = [];
  const f = await fixture(t, mcp('answer', body => calls.push(body)), {reply: {text: 'reply question'}});
  await f.run('.deepwiki add first https://github.com/owner/first');
  await f.run('.deepwiki add second https://github.com/owner/second');
  await f.run('.deepwiki first', {replyToId: 9});
  const tool = calls.find(body => body.method === 'tools/call');
  assert.equal(tool.params.arguments.repoName, 'owner/first');
  assert.equal(tool.params.arguments.question, 'reply question');
  assert.match(f.edits.at(-1), /reply question/);
});

test('DEEPWIKI-COMPAT-02 legacy context is bounded to 50 turns before building the MCP request', async t => {
  let question;
  const turns = Array.from({length: 80}, (_, index) => ({q: `old-${index}`, a: 'a'.repeat(2000), at: ''}));
  const initial = {schemaVersion: 1, legacyImported: true, chats: {'100': {currentTag: 'core', repos: {core: {tag: 'core', repo: 'owner/repo', url: '', addedAt: ''}}, contextEnabled: true, turns: {core: turns}}}};
  const f = await fixture(t, mcp('answer', body => {if (body.method === 'tools/call') question = body.params.arguments.question;}), {initial});
  await f.run('.deepwiki current');
  assert.ok(question.length <= 48000);
  assert.doesNotMatch(question, /old-(?:[0-2]?\d)\b/);
  assert.match(question, /old-79/);
  assert.match(question, /当前问题:\ncurrent/);
});

test('DEEPWIKI-COMPAT-03 an oversized MCP response is bounded and produces safe feedback', async t => {
  let canceled = false;
  const oversized = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));}, cancel() {canceled = true;}});
  const f = await fixture(t, async (_url, init) => {const body = JSON.parse(init.body);
    if (body.method === 'initialize') return new Response('{}', {headers: {'mcp-session-id': 'local'}});
    if (body.method === 'notifications/initialized') return new Response('', {status: 202});
    return new Response(oversized);
  });
  await f.run('.deepwiki add core https://github.com/owner/repo');
  await f.run('.deepwiki question');
  assert.equal(canceled, true);
  assert.equal(f.edits.at(-1), '❌ DeepWiki 操作失败，请检查参数或稍后重试');
});

test('DEEPWIKI-COMPAT-04 unload cancels a blocked MCP body read and waits for reader cleanup', async t => {
  const reading = deferred(), readDone = deferred(), cleaned = deferred(); let canceled = false, locked = true;
  const reader = {read() {reading.resolve(); return readDone.promise;}, async cancel() {canceled = true; readDone.resolve({done: true}); await cleaned.promise;}, releaseLock() {locked = false;}};
  const blocked = {status: 200, ok: true, headers: new Headers(), body: {get locked() {return locked;}, getReader() {return reader;}, async cancel() {}}};
  const f = await fixture(t, async (_url, init) => {const body = JSON.parse(init.body);
    if (body.method === 'initialize') return new Response('{}', {headers: {'mcp-session-id': 'local'}});
    if (body.method === 'notifications/initialized') return new Response('', {status: 202});
    return blocked;
  });
  await f.run('.deepwiki add core https://github.com/owner/repo');
  const running = f.run('.deepwiki question');
  await reading.promise;
  const first = await f.host.unload('deepwiki', 5);
  assert.equal(first.completed, false);
  assert.equal(canceled, true);
  assert.deepEqual(f.replies, []);
  cleaned.resolve();
  await running;
  assert.equal((await f.host.unload('deepwiki', 1000)).completed, true);
});

test('DEEPWIKI-COMPAT-05 ctx status reports turn counts and deleting an unknown tag fails safely', async t => {
  const f = await fixture(t, mcp('answer'));
  await f.run('.deepwiki add core https://github.com/owner/repo');
  await f.run('.deepwiki ctx');
  assert.match(f.edits.at(-1), /core.*缓存轮数：<b>0<\/b>/);
  await f.run('.deepwiki ctx del missing');
  assert.equal(f.edits.at(-1), '❌ DeepWiki 操作失败，请检查参数或稍后重试');
});

test('DEEPWIKI-COMPAT-06 later page failure preserves the result and reports a stable interruption', async t => {
  const f = await fixture(t, mcp('answer '.repeat(5000)), {failReplyAt: 1});
  await f.run('.deepwiki add core https://github.com/owner/repo');
  await f.run('.deepwiki question');
  assert.match(f.edits.at(-1), /<b>DeepWiki<\/b>/);
  assert.doesNotMatch(f.edits.at(-1), /操作失败/);
  assert.match(f.replies.at(-1), /^⚠️ 已发送 1\/\d+ 页，后续页发送中断/);
  assert.equal(f.logs.at(-1).event, 'pagination_delivery_interrupted');
  assert.deepEqual({...f.logs.at(-1).fields, total: undefined}, {plugin: 'deepwiki', published: 1, total: undefined, category: 'Error'});
  assert.ok(f.logs.at(-1).fields.total > 1);
});

test('DEEPWIKI-COMPAT-07 first page failure follows the normal command failure path', async t => {
  const f = await fixture(t, mcp('answer'), {failEditAt: 3});
  await f.run('.deepwiki add core https://github.com/owner/repo');
  await f.run('.deepwiki question');
  assert.equal(f.edits.at(-1), '❌ DeepWiki 操作失败，请检查参数或稍后重试');
  assert.deepEqual(f.replies, []);
  assert.deepEqual(f.logs.at(-1), {event: 'pagination_delivery_interrupted', fields: {plugin: 'deepwiki', published: 0, total: 1, category: 'Error'}});
});

test('DEEPWIKI-COMPAT-08 project and context inventories paginate without losing rows', async t => {
  const repos = Object.fromEntries(Array.from({length: 180}, (_, index) => {
    const tag = `project-${String(index).padStart(3, '0')}`;
    return [tag, {tag, repo: `owner-${index}/repository-${'x'.repeat(30)}-${index}`, url: '', addedAt: ''}];
  }));
  const initial = {schemaVersion: 1, legacyImported: true, chats: {'100': {currentTag: 'project-000', repos, contextEnabled: true, turns: {}}}};
  const f = await fixture(t, mcp('answer'), {initial});
  await f.run('.deepwiki lst');
  assert.ok(f.replies.length > 0);
  assert.match([...f.edits, ...f.replies].join('\n'), /project-179/);
  const before = f.replies.length;
  await f.run('.deepwiki ctx');
  assert.ok(f.replies.length > before);
  assert.match([...f.edits, ...f.replies.slice(before)].join('\n'), /project-179.*缓存轮数/);
});
