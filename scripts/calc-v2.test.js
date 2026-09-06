'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'calc', packageRoot: path.resolve(__dirname, '../calc'), entry: 'v2.ts'});
const createCalc = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-calc-v2-')));
  const edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(message, text, options) { edits.push({message, text, options}); },
    async reply() { assert.fail('unexpected reply'); },
    async invoke() { assert.fail('unexpected invoke'); },
    async getReply() { return undefined; },
    async withClient() { assert.fail('unexpected native call'); },
  }});
  await host.load(createCalc());
  t.after(async () => { assert.equal((await host.shutdown(1000)).completed, true); await fs.rm(root, {recursive: true, force: true}); });
  return {host, edits, run: text => host.dispatchPrimary({id: 1, chatId: '123', senderId: '123', outgoing: true, text})};
}

test('calc evaluates supported expressions without native resources', async t => {
  const f = await fixture(t);
  await f.run('.calc -(2-5)/3');
  assert.match(f.edits.at(-1).text, /1/);
  assert.equal(f.edits.at(-1).options.parseMode, 'html');
  await f.run('.calc 2+2*5');
  assert.match(f.edits.at(-1).text, /12/);
});

test('calc rejects unsafe syntax, division by zero and oversized input', async t => {
  const f = await fixture(t);
  for (const expression of ['.calc 1/0', '.calc 1+eval(2)', '.calc 1..2', `.calc ${'1'.repeat(121)}`]) {
    await f.run(expression);
    assert.match(f.edits.at(-1).text, /计算失败/);
  }
  assert.doesNotMatch(f.edits.at(-1).text, /eval/);
});

test('calc help escapes dynamic prefixes', async t => {
  const f = await fixture(t);
  await f.run('.calc help');
  assert.match(f.edits[0].text, /计算器/);
  assert.equal(f.edits[0].options.parseMode, 'html');
});
