'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'javdb', packageRoot: path.resolve(__dirname, '../javdb'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

const search = `<div class="movie-list"><div class="item"><a href="/v/abc"><div class="video-title">ABP-123 &lt;title&gt;</div><div class="cover"><img src="https://c0.jdbstatic.com/a.jpg"></div><div class="score"><span class="value">4.5</span></div></a></div></div>`;
const detail = `<div class="panel-block"><strong>導演</strong><span class="value"><a>&lt;Dir&gt;</a></span></div><div class="panel-block"><strong>演員</strong><span class="value"><a>Alice</a></span></div><div class="panel-block"><strong>類別</strong><span class="value"><a>Tag</a></span></div><div class="score"><span class="value">4.5</span></div>`;

function fixture(imageFails = false, sentId) {
  const edits = [], urls = [], sends = [], requests = [], tasks = [], deletes = [];
  const raw = {peerId: 7, async delete() {}};
  const context = {signal: new AbortController().signal, log: {info() {}, error() {}}, http: {
    async text(url, init, options) {urls.push(String(url)); requests.push({url: String(url), init, options}); return urls.length === 1 ? search : detail;},
    async withResponse(url, init, consume, options) {urls.push(String(url)); requests.push({url: String(url), init, options}); if (imageFails) throw new Error('private'); return consume(new Response('jpg', {headers: {'content-type': 'image/jpeg'}}), context.signal);},
  }, telegram: {async edit(message, text, options) {edits.push({message, text, options});},
    async withClient(operation) {return operation({async sendFile(peer, value) {sends.push({peer, value}); return sentId === undefined ? undefined : {id: sentId};},
      async deleteMessages(...args) {deletes.push(args);}}, context.signal);}},
    tasks: {run(label, operation) {tasks.push({label, operation}); return Promise.resolve();}},
  };
  return {edits, urls, sends, requests, tasks, deletes, run: text => create().commands.av.handle({command: 'av', prefix: '.', args: text.split(/\s+/).slice(1), message: {id: 1, chatId: '7', outgoing: true, text, raw}}, context)};
}

test('javdb normalizes codes, parses escaped details, and sends a spoiler cover', async () => {
  const f = fixture();
  await f.run('.av abp 123');
  assert.match(f.urls[0], /q=ABP-123/);
  assert.equal(f.sends[0].value.spoiler, true);
  assert.match(f.sends[0].value.caption, /&lt;title&gt;[\s\S]*&lt;Dir&gt;[\s\S]*Alice/);
  assert.deepEqual(f.requests.map(value => value.options.redirects), [
    {allowedHosts: ['javdb.com'], maxRedirects: 3},
    {allowedHosts: ['javdb.com'], maxRedirects: 3},
    {allowedHosts: ['c0.jdbstatic.com'], maxRedirects: 2},
  ]);
});

test('javdb registers cover deletion in the plugin lifecycle and cancellation stops it', async () => {
  const f = fixture(false, 88);
  await f.run('.av ABP-123');
  assert.equal(f.tasks.length, 1);
  assert.equal(f.tasks[0].label, 'javdb:delete-cover');
  const controller = new AbortController();
  const pending = f.tasks[0].operation(controller.signal);
  controller.abort();
  await pending;
  assert.equal(f.deletes.length, 0);
});

test('javdb falls back to text when cover download fails', async () => {
  const f = fixture(true);
  await f.run('.javdb ABP-123');
  assert.equal(f.sends.length, 0);
  assert.match(f.edits.at(-1).text, /JavDB/);
  assert.doesNotMatch(f.edits.at(-1).text, /private/);
});

test('javdb rejects malformed codes before network access', async () => {
  const f = fixture();
  await f.run('.jd ../../etc/passwd');
  assert.equal(f.urls.length, 0);
  assert.match(f.edits.at(-1).text, /格式无效/);
});
