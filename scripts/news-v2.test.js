'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'news', packageRoot: path.resolve(__dirname, '../news'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('news parses bounded data and escapes rich text', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-news-v2-')));
  const edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {
    fetch: async () => new Response(JSON.stringify({data: {
      newsList: [{title: '<headline>', url: 'https://example.com/a'}],
      historyList: [{event: '历史事件'}], phrase: {phrase: '成语', explain: '解释'},
      sentence: {sentence: '名言', author: '作者'},
    }}), {status: 200}),
  }, telegram: {async edit(m, text, options) {edits.push({text, options});}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {}}});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  await host.dispatchPrimary({id: 1, chatId: 'chat', senderId: 'owner', outgoing: true, text: '.news'});
  assert.match(edits.at(-1).text, /&lt;headline&gt;/);
  assert.match(edits.at(-1).text, /历史事件/);
  assert.equal(edits.at(-1).options.parseMode, 'html');
});

test('news retains all entries and poem across valid rich-text pages', async () => {
  const output = [];
  const data = {
    newsList: Array.from({length: 20}, (_, i) => ({title: `headline-${i}`, url: `https://example.com/${i}`})),
    historyList: [{event: 'first-history'}, {event: 'last-history'}],
    poem: {title: 'poem-title', author: 'poem-author', content: ['<&😀'.repeat(2000), 'poem-end']},
  };
  const send = async (_, text) => output.push(text);
  await create().commands.news.handle({args: [], message: {}, prefix: '.', command: 'news'}, {
    signal: new AbortController().signal,
    telegram: {edit: send, reply: send},
    http: {json: async () => ({data})},
  });
  const pages = output.slice(1);
  assert.ok(pages.length > 1);
  for (const page of pages) {
    assert.ok(page.length <= 3500);
    for (const tag of ['a', 'b', 'i']) {
      assert.equal((page.match(new RegExp(`<${tag}(?:\\s[^>]+)?>`, 'g')) || []).length,
        (page.match(new RegExp(`</${tag}>`, 'g')) || []).length);
    }
  }
  const combined = pages.join('\n');
  assert.match(combined, /headline-19/);
  assert.match(combined, /last-history/);
  assert.match(combined, /poem-end/);
  for (const token of ['&lt;', '&amp;', '😀']) {
    assert.equal(combined.split(token).length - 1, 2000);
  }
});

test('news rejects unknown arguments without requesting content', async () => {
  const output = [];
  await create().commands.news.handle({args: ['invalid'], message: {}}, {
    telegram: {edit: async (_, text) => output.push(text)},
    http: {json: () => assert.fail('unexpected HTTP')},
  });
  assert.match(output[0], /未知参数/);
});
