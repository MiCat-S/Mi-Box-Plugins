'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

const factories = {};
function load(id) {
  if (!factories[id]) {
    const built = buildPlugin({id, packageRoot: path.resolve(__dirname, '..', id), entry: 'v2.ts'});
    factories[id] = require(path.join(built.artifactDir, 'index.cjs')).default;
  }
  return factories[id];
}

async function fixture(t, id, {files = {}, http} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mibot-${id}-list-`)));
  await fs.mkdir(path.join(root, id));
  for (const [name, value] of Object.entries(files)) {
    await fs.writeFile(path.join(root, id, name), JSON.stringify(value));
  }
  const edits = [], replies = [];
  const host = new PluginHost({
    storageRoot: root, tempRoot: path.join(root, 'temp'), logger: {info() {}, error() {}},
    telegram: {
      async edit(_m, text) {edits.push(text);}, async reply(_m, text) {replies.push(text);},
      async invoke() {assert.fail('unexpected RPC');}, async getReply() {}, async withClient(fn, signal) {return fn({}, signal);},
    },
    http: {fetch: async (url, init) => {
      if (!http) assert.fail(`unexpected request ${url}`);
      return http(new URL(url), init);
    }},
  });
  await host.load(load(id)());
  t.after(async () => {await host.shutdown(2000); await fs.rm(root, {recursive: true, force: true});});
  return {
    edits, replies,
    run: text => host.dispatchPrimary({id: 9, chatId: '123', senderId: '123', outgoing: true, text, raw: {peerId: '123'}}),
    pages: () => [edits.at(-1), ...replies],
  };
}

function balanced(html) {
  const stack = [];
  for (const match of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (match[1]) { if (stack.pop() !== match[2]) return false; }
    else if (!match[0].endsWith('/>')) stack.push(match[2]);
  }
  return stack.length === 0;
}

test('acron paginates every task instead of slicing the joined html', async t => {
  const tasks = Array.from({length: 60}, (_, index) => ({
    id: String(index + 1), type: 'send', cron: '0 0 0 * * *', chat: '123', chatId: '123',
    createdAt: new Date(0).toISOString(), disabled: true,
    remark: `任务${index + 1}-${'测'.repeat(60)}`,
  }));
  const f = await fixture(t, 'acron', {files: {'acron_config.json': {schemaVersion: 1, seq: '60', tasks}}});
  await f.run('.acron list all');
  const pages = f.pages();
  const output = pages.join('\n');
  assert.ok(pages.length > 1, `expected multiple pages, got ${pages.length}`);
  assert.ok(output.includes('>1<') && output.includes('>60<'), 'all task ids must be present');
  assert.doesNotMatch(output, /slice/);
  for (const page of pages) assert.ok(balanced(page), `unbalanced tags: ${page.slice(0, 80)}`);
});

test('checkapi paginates the full model list after escaping', async t => {
  const names = Array.from({length: 100}, (_, index) => `model-${String(index).padStart(3, '0')}-${'x'.repeat(60)}`);
  const f = await fixture(t, 'checkapi', {
    files: {'keys-v2.json': {schemaVersion: 1, legacyImported: true,
      entries: [{name: 'test', key: 'k'.repeat(20), baseUrl: 'https://api.invalid', addedAt: 1}]}},
    http: async target => {
      assert.equal(target.pathname, '/models');
      return Response.json({data: names.map(id => ({id}))});
    },
  });
  await f.run('.checkapi models test');
  const pages = f.pages();
  const output = pages.join('\n');
  assert.ok(pages.length > 1, `expected multiple pages, got ${pages.length}`);
  assert.ok(output.includes('model-000'), 'first model must be present');
  assert.ok(output.includes('model-099'), 'last model must be present');
  for (const page of pages) assert.ok(balanced(page), `unbalanced tags: ${page.slice(0, 80)}`);
});

test('komari paginates a long report instead of one oversized edit', async t => {
  const siteName = `站点-${'测'.repeat(3400)}`;
  const f = await fixture(t, 'komari', {
    files: {'config-v2.json': {schemaVersion: 1, url: 'https://komari.invalid', legacyImported: true}},
    http: async target => {
      if (target.pathname.endsWith('/api/public')) return Response.json({status: 'success', data: {sitename: siteName}});
      if (target.pathname.endsWith('/api/version')) return Response.json({status: 'success', data: {version: '1.0', hash: 'abc'}});
      if (target.pathname.endsWith('/api/nodes')) return Response.json({status: 'success', data: []});
      assert.fail(`unexpected request ${target.pathname}`);
    },
  });
  await f.run('.komari status');
  const pages = f.pages();
  const output = pages.join('\n');
  assert.ok(pages.length > 1, `expected multiple pages, got ${pages.length}`);
  assert.ok(output.includes(siteName.slice(0, 40)), 'report content must be preserved');
  assert.doesNotMatch(output, /\*\*Komari/);
  for (const page of pages) assert.ok(balanced(page), `unbalanced tags: ${page.slice(0, 80)}`);
});
