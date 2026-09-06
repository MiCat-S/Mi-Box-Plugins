'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'jupai', packageRoot: path.resolve(__dirname, '../jupai'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('jupai uses reply text and sends bounded image', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-jupai-v2-')));
  const edits = []; const sent = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {
    fetch: async () => new Response(new Uint8Array([1, 2, 3]), {status: 200}),
  }, telegram: {
    async edit(m, text, options) { edits.push({text, options}); }, async reply() {}, async invoke() {},
    async getReply() { return {id: 2, chatId: 'chat', senderId: 'u', outgoing: false, text: '回复文本'}; },
    async withClient(operation, signal) { return operation({sendFile: async (...args) => sent.push(args)}, signal); },
  }});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  await host.dispatchPrimary({id: 1, chatId: 'chat', senderId: 'owner', outgoing: true, text: '.jupai'});
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'chat');
  assert.match(edits.at(-1).text, /已发送/);
});

for (const scenario of ['oversize', 'abort', 'empty']) {
  test(`jupai ${scenario} response never uploads and releases its reader`, async () => {
    const controller = new AbortController();
    let canceled = 0;
    let entered;
    const reading = new Promise(resolve => {entered = resolve;});
    const stream = new ReadableStream({
      start(target) {
        if (scenario === 'oversize') target.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
        if (scenario === 'empty') target.close();
      },
      pull() {entered();},
      cancel() {canceled++;},
    });
    const response = new Response(stream);
    const edits = [];
    const running = create().commands.jupai.handle({
      message: {id: 1, chatId: '1', text: '.jupai test', outgoing: true},
      args: ['test'], prefix: '.', command: 'jupai',
    }, {
      signal: controller.signal,
      http: {withResponse: async (_, init, consume) => consume(response, controller.signal)},
      telegram: {
        edit: async (_, text) => edits.push(text),
        withClient: () => assert.fail('unexpected upload'),
      },
    });
    if (scenario === 'abort') {await reading; controller.abort();}
    await running;
    assert.equal(response.body.locked, false);
    assert.equal(canceled, scenario === 'empty' ? 0 : 1);
    if (scenario === 'abort') assert.equal(edits.length, 1);
    else assert.match(edits.at(-1), /生成失败/);
  });
}
