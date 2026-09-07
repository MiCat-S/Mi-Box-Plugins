'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'bizhi', packageRoot: path.resolve(__dirname, '../bizhi'), entry: 'v2.ts'});
const createBizhi = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t, fetch) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-bizhi-v2-')));
  const edits = [], files = [], requests = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch: async (url, init) => {
    requests.push(new URL(url)); return fetch(new URL(url), init);
  }}, telegram: {
    async edit(message, text, options) { edits.push({message, text, options}); },
    async reply() { assert.fail('unexpected reply'); },
    async invoke() { assert.fail('unexpected invoke'); },
    async getReply() { return undefined; },
    async withClient(operation, signal) { return operation({async sendFile(peer, value) { files.push({peer, value}); }}, signal); },
  }});
  await host.load(createBizhi());
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {edits, files, requests, run: text => host.dispatchPrimary({
    id: 1, chatId: '1', senderId: '1', outgoing: true, text, raw: {peerId: {}},
  })};
}

test('bizhi downloads and sends a qualified Wallhaven image', async t => {
  const f = await fixture(t, async url => {
    if (url.hostname === 'wallhaven.cc') return Response.json({data: [{
      id: 'abc', path: 'https://w.wallhaven.cc/full/ab/wallhaven-abc.jpg',
      dimension_x: 2560, dimension_y: 1440, file_size: 4 * 1024 * 1024, file_type: 'image/jpeg',
    }]});
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), {headers: {'content-type': 'image/jpeg'}});
  });
  await f.run('.bizhi dongman');
  assert.equal(f.files.length, 1);
  assert.match(f.files[0].value.caption, /2560×1440/);
  assert.equal(f.files[0].value.forceDocument, false);
  assert.equal(f.requests.some(url => url.hostname === 'w.wallhaven.cc'), true);
});

test('bizhi falls back to btstu when Wallhaven is unavailable', async t => {
  const f = await fixture(t, async url => {
    if (url.hostname === 'wallhaven.cc') return new Response('down', {status: 503});
    if (url.hostname === 'api.btstu.cn') return Response.json({code: '200', imgurl: 'https://img.btstu.cn/example.jpg'});
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), {headers: {'content-type': 'image/jpeg'}});
  });
  await f.run('.bizhi -f');
  assert.equal(f.files.length, 1);
  assert.match(f.files[0].value.caption, /btstu\.cn/);
  assert.equal(f.files[0].value.forceDocument, true);
});

test('bizhi rejects invalid categories without a network request', async t => {
  let requested = false;
  const f = await fixture(t, async () => { requested = true; return new Response(''); });
  await f.run('.bizhi invalid');
  assert.equal(requested, false);
  assert.match(f.edits.at(-1).text, /meizi\|dongman/);
});
