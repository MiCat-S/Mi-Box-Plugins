'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'bin', packageRoot: path.resolve(__dirname, '../bin'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

test('bin validates input and formats provider fields safely', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-bin-v2-')));
  const edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {
    fetch: async url => new Response(url.includes('bincheck.io')
      ? '<meta property="og:description" content="This number: 415042 is a valid BIN number VISA issued by Example Bank in Taiwan">'
      : JSON.stringify({scheme: 'visa', type: 'debit', brand: '<Brand>', number: {length: 16, luhn: true}, prepaid: true, bank: {name: 'Fallback Bank'}, country: {name: 'Taiwan', alpha2: 'TW', currency: 'TWD'}}), {status: 200}),
  }, telegram: {async edit(m, text, options) {edits.push({text, options});}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {}}});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  await host.dispatchPrimary({id: 1, chatId: 'chat', senderId: 'owner', outgoing: true, text: '.bin 415042'});
  assert.match(edits.at(-1).text, /Visa/);
  assert.match(edits.at(-1).text, /&lt;Brand&gt;/);
  assert.match(edits.at(-1).text, /Example Bank/);
  assert.match(edits.at(-1).text, /16 位/);
  assert.match(edits.at(-1).text, /预付卡:<\/b> 是/);
  assert.equal(edits.at(-1).options.parseMode, 'html');
});
